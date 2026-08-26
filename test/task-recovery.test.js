import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTaskRecovery,
  TaskRecoveryError,
} from "../src/services/task-recovery.js";
import { createBlackboxStore } from "../src/services/blackbox-store.js";

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "s05b-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeClock() {
  let value = 1_750_000_000_000;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

function snapshot(overrides = {}) {
  return {
    repoRoot: "/tmp/project",
    branch: "codex/task",
    headCommit: { hash: "abc1234", date: "2026-08-26", subject: "base" },
    counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    entries: [{ status: " M", path: "src/app.js" }],
    truncated: false,
    ...overrides,
  };
}

function makeBoundary({ projectId = "project_001", repoRoot = "/tmp/project", stale = false } = {}) {
  const active = { id: projectId, repoRoot, stale, inspection: {} };
  return {
    active,
    async getStatus() { return { active, activeProjectId: projectId, projects: [active] }; },
  };
}

async function createSource(store, {
  projectId = "project_001",
  taskId,
  state = "failed",
  acceptanceStatus = "needs_review",
  task = "完成一个安全任务",
  before = snapshot(),
} = {}) {
  await store.beginTask({
    projectId,
    taskId,
    data: { task, projectId, repoRoot: "/tmp/project", before: { projectId, repoRoot: "/tmp/project", snapshot: before } },
  });
  await store.appendEvent({ projectId, taskId, type: "before_snapshot", data: { projectId, repoRoot: "/tmp/project", snapshot: before } });
  await store.appendEvent({ projectId, taskId, type: "state_changed", data: { state } });
  await store.closeTask({
    projectId,
    taskId,
    type: state,
    data: state === "interrupted" ? { reason: "service_restart" } : { code: "pi_not_authenticated" },
  });
  if (acceptanceStatus) {
    await store.appendEvent({
      projectId,
      taskId,
      type: "acceptance",
      data: { acceptanceStatus, userConfirmed: false, handoffWritten: false },
      allowAfterTerminal: true,
    });
  }
}

function makeRecovery(t, { boundary = makeBoundary(), currentSnapshot = snapshot(), busy = false } = {}) {
  const root = makeRoot(t);
  const clock = makeClock();
  const blackboxStore = createBlackboxStore({ rootDir: root, now: clock.now });
  const taskEvidence = {
    calls: [],
    async captureSnapshot() {
      return { projectId: boundary.active.id, repoRoot: boundary.active.repoRoot, capturedAt: new Date(clock.now()).toISOString(), snapshot: currentSnapshot };
    },
    async getStatus() { return { state: busy ? "running" : "idle", taskId: busy ? "running_task" : null, projectId: busy ? boundary.active.id : null }; },
    async start(task, options) {
      this.calls.push({ task, options });
      return "run_recovery_001";
    },
    async getEvidenceStatus() {
      return { taskId: "task_recovery_001", projectId: boundary.active.id, runId: "run_recovery_001", state: "running", executionStatus: "running" };
    },
  };
  const recovery = createTaskRecovery({
    projectBoundary: boundary,
    blackboxStore,
    taskEvidence,
    now: clock.now,
    previewTtlMs: 60_000,
    idFactory: () => "preview_001",
  });
  return { root, clock, blackboxStore, taskEvidence, recovery };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TaskRecoveryError);
    return error.code;
  }
  assert.fail("expected rejection");
}

test("failed and interrupted tasks are previewable, while stopped and successful tasks are not", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_failed", state: "failed" });
  await createSource(ctx.blackboxStore, { taskId: "task_interrupted", state: "interrupted", acceptanceStatus: null });
  await createSource(ctx.blackboxStore, { taskId: "task_stopped", state: "stopped" });
  await createSource(ctx.blackboxStore, { taskId: "task_exited", state: "exited" });

  assert.equal((await ctx.recovery.preview({ taskId: "task_failed" })).eligible, true);
  assert.equal((await ctx.recovery.preview({ taskId: "task_interrupted" })).sourceState, "interrupted");
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_stopped" })), "recovery_not_eligible");
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_exited" })), "recovery_not_eligible");
});

test("accepted tasks, missing payloads and cross-project tasks are rejected", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_accepted", state: "failed", acceptanceStatus: "accepted" });
  await createSource(ctx.blackboxStore, { taskId: "task_other", projectId: "project_other", state: "failed" });
  await ctx.blackboxStore.beginTask({ projectId: "project_001", taskId: "task_empty", data: {} });
  await ctx.blackboxStore.closeTask({ projectId: "project_001", taskId: "task_empty", type: "failed", data: {} });

  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_accepted" })), "recovery_not_eligible");
  // Cross-project task IDs are intentionally indistinguishable from missing IDs.
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_other" })), "recovery_task_not_found");
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_empty" })), "recovery_payload_unavailable");
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "missing" })), "recovery_task_not_found");
});

test("preview returns bounded safe fields and expires", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_failed", task: "API_KEY=not-a-real-key" });

  const preview = await ctx.recovery.preview({ taskId: "task_failed" });
  assert.deepEqual(Object.keys(preview).sort(), [
    "beforeHead", "branch", "changedCount", "confirmationRequired", "eligible", "expiresAt",
    "fileRollback", "head", "previewId", "projectId", "reasonCode", "sourceState", "sourceTaskId", "worktree",
  ].sort());
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.fileRollback, "not_included");
  assert.equal("task" in preview, false);
  assert.equal(JSON.stringify(preview).includes("API_KEY"), false);

  ctx.clock.advance(61_000);
  assert.equal(await rejectCode(ctx.recovery.start({ taskId: "task_failed", previewId: preview.previewId, confirmed: true })), "recovery_preview_expired");
});

test("recovery replays only the stored redacted task payload", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_secret", task: "API_KEY=sk-test-12345678901234567890" });
  const preview = await ctx.recovery.preview({ taskId: "task_secret" });
  await ctx.recovery.start({ taskId: "task_secret", previewId: preview.previewId, confirmed: true });
  const replayed = ctx.taskEvidence.calls[0].task;
  assert.equal(replayed, "[withheld_sensitive]");
  assert.ok(!replayed.includes("sk-test-12345678901234567890"));
});

test("confirmation rechecks the project fingerprint and execution lock", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_failed" });
  const preview = await ctx.recovery.preview({ taskId: "task_failed" });

  ctx.taskEvidence.getStatus = async () => ({ state: "running", taskId: "running_task", projectId: "project_001" });
  assert.equal(await rejectCode(ctx.recovery.start({ taskId: "task_failed", previewId: preview.previewId, confirmed: true })), "recovery_busy");

  const ctxChanged = makeRecovery(t);
  await createSource(ctxChanged.blackboxStore, { taskId: "task_failed" });
  const changedPreview = await ctxChanged.recovery.preview({ taskId: "task_failed" });
  ctxChanged.taskEvidence.captureSnapshot = async () => ({
    projectId: "project_001", repoRoot: "/tmp/project", capturedAt: "2026-08-26T00:00:00.000Z",
    snapshot: snapshot({ headCommit: { hash: "changed" } }),
  });
  assert.equal(await rejectCode(ctxChanged.recovery.start({ taskId: "task_failed", previewId: changedPreview.previewId, confirmed: true })), "recovery_preview_expired");
});

test("recovery requires explicit confirmation, consumes the handle once, and links a new task", async (t) => {
  const ctx = makeRecovery(t);
  await createSource(ctx.blackboxStore, { taskId: "task_failed", task: "安全地完成任务" });
  const beforeRaw = readFileSync(join(ctx.root, "project_001", "task_failed.jsonl"), "utf8");
  const preview = await ctx.recovery.preview({ taskId: "task_failed" });

  assert.equal(await rejectCode(ctx.recovery.start({ taskId: "task_failed", previewId: preview.previewId, confirmed: false })), "recovery_confirmation_required");
  const result = await ctx.recovery.start({ taskId: "task_failed", previewId: preview.previewId, confirmed: true });
  assert.deepEqual(result, { ok: true, sourceTaskId: "task_failed", taskId: "task_recovery_001", runId: "run_recovery_001" });
  assert.deepEqual(ctx.taskEvidence.calls, [{ task: "安全地完成任务", options: { recoveryOfTaskId: "task_failed", recoveryReasonCode: "pi_not_authenticated" } }]);
  assert.equal(await rejectCode(ctx.recovery.start({ taskId: "task_failed", previewId: preview.previewId, confirmed: true })), "recovery_preview_expired");

  const afterRaw = readFileSync(join(ctx.root, "project_001", "task_failed.jsonl"), "utf8");
  assert.ok(afterRaw.startsWith(beforeRaw));
  assert.ok(afterRaw.includes("recovery_confirmed"));
});

test("stale projects are never recoverable", async (t) => {
  const boundary = makeBoundary({ stale: true });
  const ctx = makeRecovery(t, { boundary });
  await createSource(ctx.blackboxStore, { taskId: "task_failed" });
  assert.equal(await rejectCode(ctx.recovery.preview({ taskId: "task_failed" })), "recovery_project_stale");
});

test("status returns a safe stale state when no active project is selected", async (t) => {
  const ctx = makeRecovery(t, {
    boundary: { active: null, async getStatus() { return { active: null, activeProjectId: null, projects: [] }; } },
  });
  assert.deepEqual(await ctx.recovery.getStatus(), {
    available: false,
    sourceTaskId: null,
    sourceState: null,
    reasonCode: null,
    state: "stale",
  });
});
