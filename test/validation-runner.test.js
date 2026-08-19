import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createValidationRunner,
  ValidationRunnerError,
} from "../src/services/validation-runner.js";

function makeBoundary(repoRoot = "/tmp/project") {
  const active = { id: "project_001", repoRoot, stale: false };
  return { getStatus: async () => ({ active, activeProjectId: active.id, projects: [active] }) };
}

function makeSpawn({ code = 0, stdout = "ok\n", stderr = "", delayMs = 0 } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      calls.push({ signal });
      if (!child.closed) {
        child.closed = true;
        queueMicrotask(() => child.emit("close", null, signal));
      }
      return true;
    };
    calls.push({ executable, args, options, child });
    queueMicrotask(() => {
      child.emit("spawn");
      setTimeout(() => {
        if (child.closed) return;
        if (stdout) child.stdout.emit("data", Buffer.from(stdout));
        if (stderr) child.stderr.emit("data", Buffer.from(stderr));
        child.closed = true;
        child.emit("close", code, null);
      }, delayMs);
    });
    return child;
  };
  return { calls, spawnImpl };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ValidationRunnerError);
    return error.code;
  }
  assert.fail("expected rejection");
}

test("runs an approved executable with exact argv, shell false, and active repo cwd", async () => {
  const { calls, spawnImpl } = makeSpawn({ stdout: "passed\n" });
  const runner = createValidationRunner({
    projectBoundary: makeBoundary(),
    spawnImpl,
    now: () => 1_750_000_000_000,
  });
  const result = await runner.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true });
  assert.equal(result.result, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, "/tmp/project");
  assert.equal(result.output, "passed\n");
  assert.equal(calls[0].executable, "npm");
  assert.deepEqual(calls[0].args, ["test"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "/tmp/project");
});

test("rejects shell syntax, empty executables, environment assignments, and unapproved runs", async () => {
  const { spawnImpl } = makeSpawn();
  const runner = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl });
  const cases = [
    { executable: "", args: [], approvedByUser: true, code: "invalid_command" },
    { executable: "npm test", args: [], approvedByUser: true, code: "unsafe_command" },
    { executable: "npm;rm", args: [], approvedByUser: true, code: "unsafe_command" },
    { executable: "npm", args: ["test|cat"], approvedByUser: true, code: "unsafe_command" },
    { executable: "npm", args: ["$(whoami)"], approvedByUser: true, code: "unsafe_command" },
    { executable: "npm", args: ["KEY=value"], approvedByUser: true, code: "unsafe_command" },
    { executable: "npm", args: ["test"], approvedByUser: false, code: "approval_required" },
  ];
  for (const input of cases) assert.equal(await rejectCode(runner.run(input)), input.code);
});

test("allows only one validation run at a time", async () => {
  const { spawnImpl } = makeSpawn({ delayMs: 100 });
  const runner = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl });
  const first = runner.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await rejectCode(runner.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true })), "busy");
  await first;
});

test("caps output and withholds sensitive streams without exposing stderr", async () => {
  const { spawnImpl } = makeSpawn({ stdout: "API_KEY=sk-test-12345678901234567890\nvisible", stderr: "secret-internal" });
  const runner = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl, outputLimit: 12 });
  const result = await runner.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true });
  assert.equal(result.result, "passed");
  assert.equal(result.withheld, true);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes("sk-test-12345678901234567890"));
  assert.ok(!JSON.stringify(result).includes("secret-internal"));
  assert.ok(!("stderr" in result));
});

test("maps nonzero exits to failed and cancellation to stopped", async () => {
  const failed = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl: makeSpawn({ code: 3 }).spawnImpl });
  const failedResult = await failed.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true });
  assert.equal(failedResult.result, "failed");
  assert.equal(failedResult.exitCode, 3);

  const slow = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl: makeSpawn({ delayMs: 200 }).spawnImpl });
  const pending = slow.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await slow.stop()).state, "stopping");
  assert.equal((await pending).result, "stopped");
});

test("rejects stale or non-active cwd", async () => {
  const { spawnImpl } = makeSpawn();
  const stale = createValidationRunner({
    projectBoundary: { getStatus: async () => ({ active: { id: "p", repoRoot: "/tmp/project", stale: true } }) },
    spawnImpl,
  });
  assert.equal(await rejectCode(stale.run({ executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: true })), "project_stale");

  const wrong = createValidationRunner({ projectBoundary: makeBoundary(), spawnImpl });
  assert.equal(await rejectCode(wrong.run({ executable: "npm", args: ["test"], cwd: "/tmp/other", approvedByUser: true })), "cwd_not_active_project");
});

