import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ProviderError } from "../src/providers/deepseek.js";
import { createEscortService } from "../src/services/escort-service.js";

const FAKE_KEY = "fake-deepseek-key-123456";
const FIXED_NOW = new Date("2026-08-06T12:00:00.000Z");

function createMemoryCredentialStore(initial = null) {
  let secret = initial;
  const calls = { has: 0, get: 0, set: [], delete: 0 };
  return {
    calls,
    async has() { calls.has += 1; return secret !== null; },
    async get() { calls.get += 1; return secret; },
    async set(next) { calls.set.push(next); secret = next; },
    async delete() { calls.delete += 1; const existed = secret !== null; secret = null; return existed; },
  };
}

function createProvider(implementation = async () => ({ text: "OK", model: "deepseek-v4-flash" })) {
  const calls = [];
  return {
    calls,
    async complete(input) { calls.push(input); return implementation(input); },
  };
}

function serviceWith({ secret = null, provider, credentialStore } = {}) {
  const store = credentialStore || createMemoryCredentialStore(secret);
  const fakeProvider = provider || createProvider();
  return {
    store,
    provider: fakeProvider,
    service: createEscortService({
      credentialStore: store,
      provider: fakeProvider,
      now: () => FIXED_NOW,
    }),
  };
}

test("status is unconfigured without a Key and unchecked after restart with one", async () => {
  const empty = serviceWith();
  assert.deepEqual(await empty.service.getStatus(), {
    provider: "deepseek",
    configured: false,
    display: null,
    availability: "unconfigured",
    lastCheckedAt: null,
    error: null,
  });

  const configured = serviceWith({ secret: FAKE_KEY });
  const status = await configured.service.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.display, "••••••••（已安全保存）");
  assert.equal(status.availability, "unchecked");
  assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);
});

test("saveCredential validates, trims, saves once, and never returns the Key", async () => {
  const { service, store } = serviceWith();
  const status = await service.saveCredential(`  ${FAKE_KEY}\n`);

  assert.deepEqual(store.calls.set, [FAKE_KEY]);
  assert.equal(status.availability, "unchecked");
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);

  for (const invalid of ["short", `valid-but space-123456`, "x".repeat(513), null]) {
    await assert.rejects(service.saveCredential(invalid), (error) => error.code === "invalid_credential_input");
  }
});

test("deleteCredential is idempotent and resets all state", async () => {
  const { service, store } = serviceWith({ secret: FAKE_KEY });
  await service.checkConnection();
  assert.equal((await service.getStatus()).availability, "available");

  const first = await service.deleteCredential();
  const second = await service.deleteCredential();
  assert.equal(first.availability, "unconfigured");
  assert.equal(second.availability, "unconfigured");
  assert.equal(store.calls.delete, 2);
});

test("successful connection check records a real available state", async () => {
  const { service, provider } = serviceWith({ secret: FAKE_KEY });
  const status = await service.checkConnection();

  assert.equal(status.availability, "available");
  assert.equal(status.lastCheckedAt, FIXED_NOW.toISOString());
  assert.equal(status.error, null);
  assert.equal(provider.calls[0].apiKey, FAKE_KEY);
  assert.equal(provider.calls[0].maxTokens, 8);
  assert.match(provider.calls[0].messages.at(-1).content, /OK/);
});

for (const [providerCode, expectedAvailability] of [
  ["insufficient_balance", "limited"],
  ["rate_limited", "limited"],
  ["credential_invalid", "unavailable"],
  ["network_error", "unavailable"],
  ["timeout", "unavailable"],
]) {
  test(`connection check maps ${providerCode} to ${expectedAvailability}`, async () => {
    const provider = createProvider(async () => { throw new ProviderError(providerCode); });
    const { service } = serviceWith({ secret: FAKE_KEY, provider });

    const status = await service.checkConnection();
    assert.equal(status.availability, expectedAvailability);
    assert.equal(status.error.code, providerCode);
    assert.equal(typeof status.error.action, "string");
    assert.equal(status.lastCheckedAt, FIXED_NOW.toISOString());
    assert.equal(JSON.stringify(status).includes(FAKE_KEY), false);
  });
}

test("chat sanitizes history, adds a no-tools system instruction, and returns safe output", async () => {
  const { service, provider } = serviceWith({ secret: FAKE_KEY });
  const history = Array.from({ length: 15 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `message-${index}`,
    secret: FAKE_KEY,
  }));
  history.push({ role: "tool", content: "must be removed" });

  const result = await service.sendMessage({ message: "  怎么配置 Pi？ ", history });

  assert.deepEqual(result, {
    text: "OK",
    model: "deepseek-v4-flash",
    provider: "deepseek",
    status: await service.getStatus(),
  });
  const messages = provider.calls[0].messages;
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /没有.*工具|不能.*执行/);
  assert.equal(messages.some((item) => item.role === "tool"), false);
  assert.equal(messages.at(-1).content, "怎么配置 Pi？");
  assert.ok(messages.length <= 14); // system + at most 12 history + current user
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
});

test("a second cost-bearing operation fails fast with busy", async () => {
  let resolveProvider;
  const provider = createProvider(() => new Promise((resolve) => { resolveProvider = resolve; }));
  const { service } = serviceWith({ secret: FAKE_KEY, provider });

  const first = service.sendMessage({ message: "first", history: [] });
  while (!resolveProvider) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    service.checkConnection(),
    (error) => error.code === "busy" && error.retryable === true,
  );
  resolveProvider({ text: "done", model: "deepseek-v4-flash" });
  await first;
});

test("invalid messages fail before reading a Key or calling the Provider", async () => {
  const { service, store, provider } = serviceWith({ secret: FAKE_KEY });
  for (const message of ["", " ", "x".repeat(8001), null]) {
    await assert.rejects(service.sendMessage({ message, history: [] }), (error) => error.code === "invalid_message");
  }
  assert.equal(store.calls.get, 0);
  assert.equal(provider.calls.length, 0);
});

test("escort service stays independent of CLI Agent modules", async () => {
  const source = await readFile(new URL("../src/services/escort-service.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /agent-caller|agent-catalog|\.\/config\.js|\.\.\/config\.js/);
});
