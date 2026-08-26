import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAiHandoff } from "../src/services/ai-handoff.js";
import { createBlackboxStore } from "../src/services/blackbox-store.js";
import { createGitInspector } from "../src/services/git-inspector.js";
import { createProjectBoundary } from "../src/services/project-boundary.js";
import { createTaskEvidence } from "../src/services/task-evidence.js";
import { createTaskRecovery } from "../src/services/task-recovery.js";
import { createPiExecutor } from "../src/services/pi-executor.js";
import { createValidationRunner } from "../src/services/validation-runner.js";

const GIT_OPTS = ["-c", "user.name=s04-test", "-c", "user.email=s04@test.local", "-c", "init.defaultBranch=main"];

function git(cwd, ...args) {
  const result = spawnSync("git", [...GIT_OPTS, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git failed: ${args.join(" ")}`);
  return result.stdout.trim();
}

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "s04-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRepo(t) {
  const repo = makeRoot(t);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "existing.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  // This change predates the task and must remain classified as pre-existing.
  writeFileSync(join(repo, "existing.txt"), "pre-existing change\n");
  return repo;
}

function makeBinary(t, name, script) {
  const dir = makeRoot(t);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/bin/sh\n${script}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

function makePi(t) {
  return makeBinary(t, "pi", `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
printf 'created by pi\\n' > pi-created.txt
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"task complete"}}'
exit 0
`);
}

function makeFailingPi(t) {
  return makeBinary(t, "pi", `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
echo "internal failure" 1>&2
exit 3
`);
}

function makeValidation(t) {
  return makeBinary(t, "validate", `echo validation-ok; exit 0`);
}

async function waitForEvidence(evidence, terminalStates = ["exited", "stopped", "failed", "interrupted"]) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await evidence.getEvidenceStatus();
    if (terminalStates.includes(status.executionStatus)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("evidence task did not reach a terminal state");
}

test("S04 end-to-end: enable, run, observe Git evidence, validate, accept, and read handoff", async (t) => {
  const repo = makeRepo(t);
  const stateRoot = makeRoot(t);
  const inspector = createGitInspector();
  const boundary = createProjectBoundary({ inspector, statePath: join(stateRoot, "projects.local.json") });
  const selected = await boundary.select(repo);
  await boundary.setActive(selected.id);

  const handoff = createAiHandoff({ now: () => 1_750_000_000_000 });
  const enabled = await handoff.enableProject({ repoRoot: repo, allowAgentsPointer: true });
  await boundary.enableHandoff(selected.id, { agentsPointer: enabled.agentsPointer });

  const store = createBlackboxStore({ rootDir: join(stateRoot, "blackbox.local") });
  const piExecutor = createPiExecutor({ projectBoundary: boundary, piBinary: makePi(t), authProvider: "test-provider" });
  const evidence = createTaskEvidence({
    projectBoundary: boundary,
    gitInspector: inspector,
    blackboxStore: store,
    piExecutor,
    taskIdFactory: () => "task_e2e_001",
  });

  await evidence.start("执行任务 API_KEY=sk-test-12345678901234567890");
  const finished = await waitForEvidence(evidence);
  assert.equal(finished.executionStatus, "exited");
  assert.equal(finished.evidence.git, "verified");
  assert.ok(finished.gitEvidence.preexistingPaths.includes("existing.txt"));
  assert.ok(finished.gitEvidence.newPaths.includes("pi-created.txt"));

  const validationBinary = makeValidation(t);
  const validation = createValidationRunner({ projectBoundary: boundary, piBinary: validationBinary });
  const validationResult = await validation.run({ executable: validationBinary, args: [], cwd: repo, approvedByUser: true });
  assert.equal(validationResult.result, "passed");
  await evidence.recordValidation(validationResult);

  const status = await evidence.getEvidenceStatus();
  const handoffInput = {
    repoRoot: repo,
    taskId: status.taskId,
    taskStatus: "accepted",
    plan: { source: "docs/NOW.md", revision: "v0.1-r1", completed: 9, total: 11, percent: 81.8 },
    before: status.before,
    after: status.after,
    evidence: status.evidence,
    facts: { verified: ["Pi exited 0", "validation exited 0"], user_confirmed: ["用户确认任务结果"], agent_reported: [], recorded_not_reverified: [], unknown: [] },
    issuesAndRisks: [],
    nextAction: "继续 S05 恢复与总览闭环",
    sourceRunId: status.runId,
  };
  const record = await handoff.writeRecord(handoffInput);
  await handoff.writeCurrent({ ...handoffInput, latestRecord: record.path });
  const accepted = await evidence.closeTask({ acceptanceStatus: "accepted", userConfirmed: true, handoffWritten: true });
  assert.equal(accepted.acceptanceStatus, "accepted");

  const currentRaw = readFileSync(join(repo, "docs/ai-ops/NOW.md"), "utf8");
  const recordRaw = readFileSync(join(repo, "docs/ai-ops/records/task_e2e_001.md"), "utf8");
  const blackboxRaw = readFileSync(join(stateRoot, "blackbox.local", selected.id, "task_e2e_001.jsonl"), "utf8");
  for (const raw of [currentRaw, recordRaw, blackboxRaw]) {
    assert.ok(raw.includes("继续 S05 恢复与总览闭环") || raw.includes("task complete"));
    assert.ok(!raw.includes("sk-test-12345678901234567890"));
  }
  assert.ok(currentRaw.includes("latest_record: docs/ai-ops/records/task_e2e_001.md"));
});

test("S04 recovery marks an open task interrupted without creating an orphan process", async (t) => {
  const root = makeRoot(t);
  const store = createBlackboxStore({ rootDir: root });
  await store.beginTask({ projectId: "project_001", taskId: "task_open" });
  const recovered = createBlackboxStore({ rootDir: root });
  assert.deepEqual(await recovered.recoverIncomplete(), [{ projectId: "project_001", taskId: "task_open", state: "interrupted" }]);
  const record = await recovered.readTask({ projectId: "project_001", taskId: "task_open" });
  assert.equal(record.events.at(-1).type, "interrupted");
});

test("S05-B recovery restarts a failed task without restoring files or rewriting its record", async (t) => {
  const repo = makeRepo(t);
  const stateRoot = makeRoot(t);
  const inspector = createGitInspector();
  const boundary = createProjectBoundary({ inspector, statePath: join(stateRoot, "projects.local.json") });
  const selected = await boundary.select(repo);
  await boundary.setActive(selected.id);
  const store = createBlackboxStore({ rootDir: join(stateRoot, "blackbox.local") });
  let taskSeq = 0;
  const evidence = createTaskEvidence({
    projectBoundary: boundary,
    gitInspector: inspector,
    blackboxStore: store,
    piExecutor: createPiExecutor({ projectBoundary: boundary, piBinary: makeFailingPi(t), authProvider: "test-provider" }),
    taskIdFactory: () => `task_s05_${++taskSeq}`,
  });
  const recovery = createTaskRecovery({ projectBoundary: boundary, blackboxStore: store, taskEvidence: evidence });

  await evidence.start("第一次失败任务");
  const failed = await waitForEvidence(evidence, ["failed"]);
  assert.equal(failed.executionStatus, "failed");
  const sourceBefore = (await store.readTask({ projectId: selected.id, taskId: failed.taskId })).events;
  const sourcePrefix = sourceBefore.map((event) => JSON.stringify(event)).join("\n");
  const headBefore = git(repo, "rev-parse", "HEAD");
  const fileBefore = readFileSync(join(repo, "existing.txt"), "utf8");

  const preview = await recovery.preview({ taskId: failed.taskId });
  assert.equal(preview.sourceTaskId, failed.taskId);
  assert.equal(preview.fileRollback, "not_included");
  const started = await recovery.start({ taskId: failed.taskId, previewId: preview.previewId, confirmed: true });
  assert.equal(started.sourceTaskId, failed.taskId);
  assert.notEqual(started.taskId, failed.taskId);
  const retried = await waitForEvidence(evidence, ["failed"]);
  assert.equal(retried.taskId, started.taskId);

  const sourceAfter = (await store.readTask({ projectId: selected.id, taskId: failed.taskId })).events;
  assert.ok(sourceAfter.map((event) => JSON.stringify(event)).join("\n").startsWith(sourcePrefix));
  const newRecord = await store.readTask({ projectId: selected.id, taskId: started.taskId });
  assert.equal(newRecord.events[0].data.recoveryOfTaskId, failed.taskId);
  assert.equal(newRecord.events.find((event) => event.type === "recovery_started")?.data.sourceTaskId, failed.taskId);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(readFileSync(join(repo, "existing.txt"), "utf8"), fileBefore);
});

test("S05-B recovery can restart a service-restart interrupted task", async (t) => {
  const repo = makeRepo(t);
  const stateRoot = makeRoot(t);
  const inspector = createGitInspector();
  const boundary = createProjectBoundary({ inspector, statePath: join(stateRoot, "projects.local.json") });
  const selected = await boundary.select(repo);
  await boundary.setActive(selected.id);
  const store = createBlackboxStore({ rootDir: join(stateRoot, "blackbox.local") });
  const before = await createTaskEvidence({
    projectBoundary: boundary,
    gitInspector: inspector,
    blackboxStore: store,
  }).captureSnapshot();
  await store.beginTask({
    projectId: selected.id,
    taskId: "task_interrupted_001",
    data: { task: "服务重启后继续任务", projectId: selected.id, repoRoot: repo, before },
  });
  const restartedStore = createBlackboxStore({ rootDir: join(stateRoot, "blackbox.local") });
  assert.deepEqual(await restartedStore.recoverIncomplete(), [{ projectId: selected.id, taskId: "task_interrupted_001", state: "interrupted" }]);

  const evidence = createTaskEvidence({
    projectBoundary: boundary,
    gitInspector: inspector,
    blackboxStore: restartedStore,
    piExecutor: createPiExecutor({ projectBoundary: boundary, piBinary: makePi(t), authProvider: "test-provider" }),
    taskIdFactory: () => "task_after_restart_001",
  });
  const recovery = createTaskRecovery({ projectBoundary: boundary, blackboxStore: restartedStore, taskEvidence: evidence });
  const preview = await recovery.preview({ taskId: "task_interrupted_001" });
  assert.equal(preview.sourceState, "interrupted");
  const started = await recovery.start({ taskId: "task_interrupted_001", previewId: preview.previewId, confirmed: true });
  assert.equal(started.taskId, "task_after_restart_001");
  const finished = await waitForEvidence(evidence, ["exited"]);
  assert.equal(finished.taskId, started.taskId);
  const source = await restartedStore.readTask({ projectId: selected.id, taskId: "task_interrupted_001" });
  assert.equal(source.events[1].type, "interrupted");
  assert.ok(source.events.some((event) => event.type === "recovery_started"));
});
