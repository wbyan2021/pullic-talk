import test from "node:test";
import assert from "node:assert/strict";

import { ProviderError, createDeepSeekProvider } from "../src/providers/deepseek.js";

const FAKE_KEY = "fake-deepseek-key-123456";

function makeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

test("complete sends a bounded DeepSeek V4 Flash request and returns safe text", async () => {
  let request;
  const provider = createDeepSeekProvider({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return makeResponse(200, {
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "  护航在线  ", reasoning_content: "private" } }],
      });
    },
  });

  const result = await provider.complete({
    apiKey: FAKE_KEY,
    messages: [
      { role: "system", content: "system", ignored: "field" },
      { role: "user", content: "hello" },
    ],
    maxTokens: 99_999,
  });

  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body, {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ],
    thinking: { type: "disabled" },
    max_tokens: 2048,
    stream: false,
  });
  assert.deepEqual(result, { text: "护航在线", model: "deepseek-v4-flash" });
  assert.equal("reasoning_content" in result, false);
});

for (const [status, code, retryable] of [
  [401, "credential_invalid", false],
  [402, "insufficient_balance", false],
  [429, "rate_limited", true],
  [400, "provider_request_invalid", false],
  [422, "provider_request_invalid", false],
  [500, "provider_unavailable", true],
  [503, "provider_unavailable", true],
  [599, "provider_unavailable", true],
]) {
  test(`maps DeepSeek HTTP ${status} to ${code}`, async () => {
    const provider = createDeepSeekProvider({
      fetchImpl: async () => makeResponse(status, { error: `raw ${FAKE_KEY}` }),
    });

    await assert.rejects(
      provider.complete({ apiKey: FAKE_KEY, messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.message.includes(FAKE_KEY), false);
        assert.equal(JSON.stringify(error).includes(FAKE_KEY), false);
        return true;
      },
    );
  });
}

test("maps a rejected fetch to a safe network error", async () => {
  const provider = createDeepSeekProvider({
    fetchImpl: async () => { throw new TypeError(`DNS failed ${FAKE_KEY}`); },
  });

  await assert.rejects(
    provider.complete({ apiKey: FAKE_KEY, messages: [{ role: "user", content: "hi" }] }),
    (error) => {
      assert.equal(error.code, "network_error");
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes(FAKE_KEY), false);
      return true;
    },
  );
});

test("maps its own timeout abort separately from network failures", async () => {
  const provider = createDeepSeekProvider({
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason || new Error("aborted")), { once: true });
    }),
  });

  await assert.rejects(
    provider.complete({ apiKey: FAKE_KEY, messages: [{ role: "user", content: "hi" }] }),
    (error) => {
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("rejects malformed successful responses", async () => {
  const bodies = ["not-json", {}, { choices: [{ message: { content: "   " } }] }];
  for (const body of bodies) {
    const provider = createDeepSeekProvider({ fetchImpl: async () => makeResponse(200, body) });
    await assert.rejects(
      provider.complete({ apiKey: FAKE_KEY, messages: [{ role: "user", content: "hi" }] }),
      (error) => error.code === "invalid_response" && !error.message.includes(FAKE_KEY),
    );
  }
});

test("rejects missing credentials and unusable messages before fetch", async () => {
  let calls = 0;
  const provider = createDeepSeekProvider({ fetchImpl: async () => { calls += 1; } });

  await assert.rejects(
    provider.complete({ apiKey: "", messages: [{ role: "user", content: "hi" }] }),
    (error) => error.code === "credential_missing",
  );
  await assert.rejects(
    provider.complete({ apiKey: FAKE_KEY, messages: [{ role: "tool", content: "bad" }] }),
    (error) => error.code === "provider_request_invalid",
  );
  assert.equal(calls, 0);
});
