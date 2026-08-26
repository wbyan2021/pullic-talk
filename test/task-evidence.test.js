import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTaskEvidence,
  TaskEvidenceError,
} from "../src/services/task-evidence.js";
import { createBlackboxStore } from "../src/services/blackbox-store.js";
import { PiExecutorError } from "../src/services/pi-executor.js";

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "s04-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeBoundary(repoRoot = "/tmp/project") {
  const active = {
    id: "project_001",
    inputPath: repoRoot,
    resolvedPath: repoRoot,
    repoRoot,
    selectedAt: "2026-08-20T00:00:00.000Z",
    stale: false,
    inspection: {},
  };
  return {
    async getStatus() {
      return { projects: [active], activeProjectId: active.id, active };
    },
  };
}

function inspection(overrides = {}) {
  return {
    inputPath: "/tmp/project",
    resolvedPath: "/tmp/project",
    repoRoot: "/tmp/project",
    branch: "codex/task",
    detached: false,
    hasCommits: true,
    headCommit: { hash: "abc1234", date: "2026-08-20", subject: "base" },
    counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    entries: [{ status: " M", path: "src/app.js" }],
    truncated: false,
    remotes: [],
    inspectedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TaskEvidenceError);
    return error.code;
  }
  assert.fail("expected rejection");
}

test("captures fresh before and after snapshots with bounded Git fields", async (t) => {
  const root = makeRoot(t);
  const calls = [];
  const gitInspector = {
    async inspect(repoRoot) {
      calls.push(repoRoot);
      return inspection(calls.length === 1
        ? {}
        : { branch: "codex/task", headCommit: { hash: "def5678", date: "2026-08-20", subject: "change" }, entries: [
          { status: " M", path: "src/app.js" },
          { status: "??", path: "docs/new.md" },
        ] });
    },
  };
  const evidence = createTaskEvidence({
    projectBoundary: makeBoundary(),
    gitInspector,
    blackboxStore: createBlackboxStore({ rootDir: root }),
    now: () => 1_750_000_000_000,
  });

  const before = await evidence.captureSnapshot();
  const after = await evidence.captureSnapshot();

  assert.equal(calls.length, 2);
  assert.equal(before.projectId, "project_001");
  assert.equal(before.repoRoot, "/tmp/project");
  assert.equal(before.snapshot.branch, "codex/task");
  assert.equal(before.snapshot.headCommit.hash, "abc1234");
  assert.deepEqual(before.snapshot.counts, { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
  assert.deepEqual(after.snapshot.entries, [
    { status: " M", path: "src/app.js" },
    { status: "??", path: "docs/new.md" },
  ]);
  assert.ok(!("stderr" in before.snapshot));
  assert.ok(!("diff" in before.snapshot));
});

test("classifies observed paths without claiming Pi causality", async () => {
  const evidence = createTaskEvidence({
    projectBoundary: makeBoundary(),
    gitInspector: { inspect: async () => inspection() },
    blackboxStore: createBlackboxStore({ rootDir: makeRoot({ after: () => {} }) }),
  });

  const result = evidence.classifySnapshots(
    { snapshot: inspection({ entries: [{ status: " M", path: "existing.js" }] }) },
    { snapshot: inspection({ entries: [
      { status: " M", path: "existing.js" },
      { status: "??", path: "new.js" },
    ] }) },
  );

  assert.equal(result.certainty, "observed");
  assert.deepEqual(result.newPaths, ["new.js"]);
  assert.deepEqual(result.preexistingPaths, ["existing.js"]);
  assert.equal(result.causality, "not_proven");
  assert.ok(!JSON.stringify(result).includes("diff"));
});

test("truncated snapshots are explicitly unknown", async (t) => {
  const evidence = createTaskEvidence({
    projectBoundary: makeBoundary(),
    gitInspector: { inspect: async () => inspection({ truncated: true }) },
    blackboxStore: createBlackboxStore({ rootDir: makeRoot(t) }),
  });

  const result = evidence.classifySnapshots(
    { snapshot: inspection({ truncated: true }) },
    { snapshot: inspection({ entries: [{ status: "??", path: "new.js" }], truncated: true }) },
  );
  assert.equal(result.certainty, "unknown");
  assert.equal(result.reason, "snapshot_truncated");
  assert.deepEqual(result.newPaths, []);
});

test("missing or stale active projects return stable errors", async (t) => {
  const root = makeRoot(t);
  const base = {
    gitInspector: { inspect: async () => inspection() },
    blackboxStore: createBlackboxStore({ rootDir: root }),
  };
  const none = createTaskEvidence({
    ...base,
    projectBoundary: { getStatus: async () => ({ active: null }) },
  });
  assert.equal(await rejectCode(none.captureSnapshot()), "no_project_selected");

  const stale = createTaskEvidence({
    ...base,
    projectBoundary: {
      getStatus: async () => ({ active: { id: "project_001", repoRoot: "/tmp/project", stale: true } }),
    },
  });
  assert.equal(await rejectCode(stale.captureSnapshot()), "project_stale");
});

function makePiFake({ startError = null, running = false } = {}) {
  const calls = { start: [], stop: 0 };
  const events = [];
  const listeners = new Set();
  let status = running
    ? { state: "running", runId: "run_001", startedAt: "2026-08-20T00:00:00.000Z", exitCode: null, truncated: false, durationMs: 1, output: "", task: "demo", lastError: null }
    : { state: "idle", runId: null, startedAt: null, exitCode: null, truncated: false, durationMs: null, output: "", task: null, lastError: null };
  function push(type, data) {
    events.push({ type, data });
    for (const listener of [...listeners]) listener(type, data);
  }
  return {
    calls,
    events,
    async start(task) {
      calls.start.push(task);
      if (startError) throw startError;
      status = { ...status, state: running ? "running" : "exited", runId: "run_001", task, exitCode: running ? null : 0, durationMs: 12 };
      if (!running) {
        push("start", { runId: "run_001", startedAt: "2026-08-20T00:00:00.000Z" });
        push("chunk", { text: "safe output" });
        push("status", { state: "exited" });
        push("done", { state: "exited", exitCode: 0, truncated: false, durationMs: 12 });
      }
      return "run_001";
    },
    stop() {
      calls.stop += 1;
      status = { ...status, state: "stopped", exitCode: null, durationMs: 20 };
      if (running) {
        push("status", { state: "stopped" });
        push("done", { state: "stopped", exitCode: null, truncated: false, durationMs: 20 });
      }
      return status;
    },
    async getStatus() { return status; },
    subscribe(listener) {
      for (const event of events) listener(event.type, event.data);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function makeEvidence(t, piExecutor, { inspections = [inspection(), inspection()] } = {}) {
  const root = makeRoot(t);
  let index = 0;
  return {
    root,
    store: createBlackboxStore({ rootDir: root }),
    evidence: createTaskEvidence({
      projectBoundary: makeBoundary(),
      gitInspector: { inspect: async () => inspections[Math.min(index++, inspections.length - 1)] },
      blackboxStore: createBlackboxStore({ rootDir: root }),
      piExecutor,
      taskIdFactory: () => "task_001",
    }),
  };
}

test("task start records ordered lifecycle events and after snapshot", async (t) => {
  const pi = makePiFake();
  const { evidence, store } = makeEvidence(t, pi);
  const runId = await evidence.start("完成一个安全任务");
  assert.equal(runId, "run_001");
  const status = await evidence.getStatus();
  assert.equal(status.state, "exited");
  assert.equal(status.taskId, "task_001");
  const record = await store.readTask({ projectId: "project_001", taskId: "task_001" });
  assert.deepEqual(record.events.map((event) => event.type), [
    "task_created", "before_snapshot", "pi_started", "output_chunk",
    "state_changed", "pi_finished", "after_snapshot", "exited",
  ]);
  assert.deepEqual(record.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("recovery start stores bounded source linkage on the new task only", async (t) => {
  const pi = makePiFake();
  const { evidence, store } = makeEvidence(t, pi);
  await evidence.start("重启失败任务", {
    recoveryOfTaskId: "task_failed_001",
    recoveryReasonCode: "pi_not_authenticated",
  });

  const record = await store.readTask({ projectId: "project_001", taskId: "task_001" });
  assert.deepEqual(record.events[0].data.recoveryOfTaskId, "task_failed_001");
  assert.deepEqual(record.events[0].data.recoveryReasonCode, "pi_not_authenticated");
  const linked = record.events.find((event) => event.type === "recovery_started");
  assert.deepEqual(linked?.data, {
    sourceTaskId: "task_failed_001",
    reasonCode: "pi_not_authenticated",
  });
  assert.ok(!JSON.stringify(record).includes("stderr"));
});

test("Pi start failures close the evidence task without leaking raw errors", async (t) => {
  const pi = makePiFake({ startError: new PiExecutorError("pi_not_authenticated") });
  const { evidence, store } = makeEvidence(t, pi);
  await assert.rejects(() => evidence.start("认证失败任务"), (error) => error.code === "pi_not_authenticated");
  const record = await store.readTask({ projectId: "project_001", taskId: "task_001" });
  assert.equal(record.events.at(-1).type, "failed");
  assert.equal(record.events.at(-1).data.code, "pi_not_authenticated");
  assert.ok(!JSON.stringify(record).includes("raw"));
});

test("stop closes a running task and evidence survives client unsubscribe", async (t) => {
  const pi = makePiFake({ running: true });
  const { evidence, store } = makeEvidence(t, pi);
  await evidence.start("可停止任务");
  const events = [];
  const unsubscribe = evidence.subscribe((type) => events.push(type));
  unsubscribe();
  const stopped = await evidence.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(pi.calls.stop, 1);
  const record = await store.readTask({ projectId: "project_001", taskId: "task_001" });
  assert.equal(record.events.at(-1).type, "stopped");
  assert.ok(events.length >= 0);
});

test("recovery marks an open blackbox task interrupted", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });
  await store.beginTask({ projectId: "project_001", taskId: "task_001" });
  const evidence = createTaskEvidence({
    projectBoundary: makeBoundary(),
    gitInspector: { inspect: async () => inspection() },
    blackboxStore: store,
    piExecutor: makePiFake(),
  });
  assert.deepEqual(await evidence.recoverIncomplete(), [{ projectId: "project_001", taskId: "task_001", state: "interrupted" }]);
});
