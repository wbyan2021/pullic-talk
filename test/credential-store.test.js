import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  CredentialStoreError,
  createCredentialStore,
  createSecurityRunner,
} from "../src/services/credential-store.js";

const FAKE_SECRET = "fake-secret-123456";

function success(stdout = "") {
  return { status: 0, stdout, stderr: "" };
}

test("set writes the secret only through stdin with -w last", async () => {
  const calls = [];
  const store = createCredentialStore({
    platform: "darwin",
    runSecurity: async (args, options = {}) => {
      calls.push({ args, options });
      return success();
    },
  });

  await store.set(FAKE_SECRET);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "add-generic-password");
  assert.deepEqual(calls[0].args.slice(-2), ["-U", "-w"]);
  assert.ok(calls[0].args.includes("com.ai-ops.cockpit.provider.deepseek"));
  assert.ok(calls[0].args.includes("default"));
  assert.ok(calls[0].args.includes("AI·OPS COCKPIT · DeepSeek"));
  assert.equal(calls[0].options.stdin, FAKE_SECRET);
  assert.equal(calls[0].args.join(" ").includes(FAKE_SECRET), false);
});

test("has checks metadata without asking security to print the password", async () => {
  const calls = [];
  const store = createCredentialStore({
    platform: "darwin",
    runSecurity: async (args, options = {}) => {
      calls.push({ args, options });
      return success("keychain metadata only");
    },
  });

  assert.equal(await store.has(), true);
  assert.equal(calls[0].args[0], "find-generic-password");
  assert.equal(calls[0].args.includes("-w"), false);
});

test("get returns a trimmed secret only to the caller", async () => {
  const store = createCredentialStore({
    platform: "darwin",
    runSecurity: async (args) => {
      assert.equal(args.at(-1), "-w");
      return success(`${FAKE_SECRET}\n`);
    },
  });

  assert.equal(await store.get(), FAKE_SECRET);
});

test("not-found is false for has, null for get, and success for delete", async () => {
  const notFound = {
    status: 44,
    stdout: "",
    stderr: "The specified item could not be found in the keychain.",
  };
  const store = createCredentialStore({
    platform: "darwin",
    runSecurity: async () => notFound,
  });

  assert.equal(await store.has(), false);
  assert.equal(await store.get(), null);
  assert.equal(await store.delete(), false);
});

test("other keychain failures use a stable safe error", async () => {
  const store = createCredentialStore({
    platform: "darwin",
    runSecurity: async () => ({
      status: 1,
      stdout: FAKE_SECRET,
      stderr: `raw failure containing ${FAKE_SECRET}`,
    }),
  });

  await assert.rejects(store.get(), (error) => {
    assert.ok(error instanceof CredentialStoreError);
    assert.equal(error.code, "credential_store_unavailable");
    assert.equal(error.message.includes(FAKE_SECRET), false);
    assert.equal(JSON.stringify(error).includes(FAKE_SECRET), false);
    return true;
  });
});

test("unsupported platforms never fall back to a file", async () => {
  let called = false;
  const store = createCredentialStore({
    platform: "linux",
    runSecurity: async () => {
      called = true;
      return success();
    },
  });

  await assert.rejects(store.has(), (error) => {
    assert.equal(error.code, "unsupported_platform");
    return true;
  });
  assert.equal(called, false);
});

test("security runner uses the absolute binary and appends stdin newline", async () => {
  let observed;
  const spawnImpl = (command, args, options) => {
    observed = { command, args, options, stdin: "" };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on("data", (chunk) => { observed.stdin += chunk.toString(); });
    child.stdin.on("finish", () => {
      child.stdout.end("ok\n");
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    });
    return child;
  };
  const runSecurity = createSecurityRunner({ spawnImpl, timeoutMs: 100 });

  const result = await runSecurity(["add-generic-password", "-w"], { stdin: FAKE_SECRET });

  assert.equal(observed.command, "/usr/bin/security");
  assert.equal(observed.options.shell, false);
  assert.equal(observed.stdin, `${FAKE_SECRET}\n`);
  assert.equal(observed.args.includes(FAKE_SECRET), false);
  assert.equal(result.stdout, "ok\n");
});

test("security runner rejects at its deadline even when the child ignores SIGTERM", async () => {
  const signals = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { signals.push(signal); return true; };
    return child;
  };
  const runSecurity = createSecurityRunner({ spawnImpl, timeoutMs: 5 });

  await assert.rejects(
    Promise.race([
      runSecurity(["find-generic-password"]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("runner did not reject at deadline")), 50)),
    ]),
    (error) => error instanceof CredentialStoreError && error.code === "credential_store_unavailable",
  );
  assert.deepEqual(signals, ["SIGTERM"]);
});
