import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import evidenceRoutes from "../src/routes/evidence.js";
import { TaskEvidenceError } from "../src/services/task-evidence.js";
import { ValidationRunnerError } from "../src/services/validation-runner.js";

class FakeApp {
  constructor() { this.routes = new Map(); }
  get(path, handler) { this.routes.set(`GET ${path}`, handler); }
  post(path, handler) { this.routes.set(`POST ${path}`, handler); }
}

class FakeResponse extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = undefined; this.writableEnded = false; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.writableEnded = true; return this; }
}

const BASE_STATUS = {
  taskId: "task_001",
  projectId: "project_001",
  repoRoot: "/tmp/project",
  state: "exited",
  runId: "run_001",
  executionStatus: "exited",
  before: { branch: "main", head: "abc1234", worktree: "modified" },
  after: { branch: "codex/s04", head: "def5678", changedPaths: ["src/app.js"] },
  gitEvidence: { certainty: "observed", causality: "not_proven", newPaths: ["src/app.js"], changedPaths: [], preexistingPaths: [] },
  evidence: { execution: "verified", git: "verified", validation: "passed" },
  validation: { result: "passed", exitCode: 0, output: "ok", executable: "npm", args: ["test"], cwd: "/tmp/project" },
  acceptanceStatus: "pending",
  task: "安全任务",
  lastError: null,
};

function createFakes(overrides = {}) {
  const calls = { start: [], recordValidation: [], close: [], preview: [], run: [], writeRecord: [], writeCurrent: [] };
  let status = structuredClone(BASE_STATUS);
  const taskEvidence = {
    calls,
    async getEvidenceStatus() { return structuredClone(status); },
    async recordValidation(result) { calls.recordValidation.push(result); status = { ...status, validation: result, evidence: { ...status.evidence, validation: result.result === "passed" ? "passed" : "failed" } }; return result; },
    async closeTask(input) { calls.close.push(input); status = { ...status, acceptanceStatus: input.acceptanceStatus }; return structuredClone(status); },
    ...overrides.taskEvidence,
  };
  const validationRunner = {
    async run(input) { calls.run.push(input); return { executable: input.executable, args: input.args, cwd: input.cwd, approvedByUser: true, result: "passed", exitCode: 0, output: "ok", withheld: false, truncated: false }; },
    ...overrides.validationRunner,
  };
  const aiHandoff = {
    async writeRecord(input) { calls.writeRecord.push(input); return { status: "written", path: "docs/ai-ops/records/task_001.md" }; },
    async writeCurrent(input) { calls.writeCurrent.push(input); return { status: "written", path: "docs/ai-ops/NOW.md" }; },
    ...overrides.aiHandoff,
  };
  const projectBoundary = {
    async getHandoff() { return { enabled: true, enabledAt: "2026-08-20T00:00:00.000Z" }; },
    ...overrides.projectBoundary,
  };
  return { calls, taskEvidence, validationRunner, aiHandoff, projectBoundary, getStatus: () => status };
}

function setup(fakes = createFakes()) {
  const app = new FakeApp();
  evidenceRoutes(app, fakes);
  return { app, ...fakes };
}

async function invoke(app, key, { body, query } = {}) {
  const handler = app.routes.get(key);
  assert.ok(handler, `route ${key} must be registered`);
  const res = new FakeResponse();
  await handler({ body, query }, res);
  return res;
}

test("registers evidence status, validation preview/run, and close endpoints", () => {
  const { app } = setup();
  for (const key of [
    "GET /api/evidence/status",
    "POST /api/evidence/validation/preview",
    "POST /api/evidence/validation/run",
    "POST /api/evidence/close",
  ]) assert.ok(app.routes.has(key), `${key} missing`);
});

test("status returns bounded evidence fields and never event buffers", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET /api/evidence/status");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.evidence.taskId, "task_001");
  assert.ok(!("events" in res.body.evidence));
  assert.ok(!JSON.stringify(res.body).includes("stderr"));
  assert.ok(!JSON.stringify(res.body).includes("安全任务"));
});

test("validation preview accepts only structured executable and argv", async () => {
  const fakes = createFakes();
  const { app } = setup(fakes);
  const preview = await invoke(app, "POST /api/evidence/validation/preview", { body: { executable: "npm", args: ["test"], cwd: "/tmp/project" } });
  assert.deepEqual(preview.body, { ok: true, validation: { executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: false, result: "not_run" } });
  const raw = await invoke(app, "POST /api/evidence/validation/preview", { body: { command: "npm test" } });
  assert.equal(raw.statusCode, 400);
  assert.equal(raw.body.code, "invalid_command");
});

test("validation run requires approval and records safe result", async () => {
  const fakes = createFakes();
  fakes.validationRunner.run = async () => { throw new ValidationRunnerError("approval_required"); };
  const { app } = setup(fakes);
  const res = await invoke(app, "POST /api/evidence/validation/run", { body: { executable: "npm", args: ["test"], cwd: "/tmp/project", approvedByUser: false } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "approval_required");
  assert.equal(fakes.calls.recordValidation.length, 0);
});

test("accepted close requires passed validation and writes current/history handoff", async () => {
  const fakes = createFakes({
    taskEvidence: {
      async getEvidenceStatus() { return { ...structuredClone(BASE_STATUS), validation: { result: "passed", exitCode: 0, output: "ok" }, evidence: { execution: "verified", git: "verified", validation: "passed" } }; },
    },
  });
  const { app } = setup(fakes);
  const res = await invoke(app, "POST /api/evidence/close", { body: { acceptanceStatus: "accepted", userConfirmed: true, nextAction: "继续开发" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.evidence.acceptanceStatus, "accepted");
  assert.equal(fakes.calls.writeRecord.length, 1);
  assert.equal(fakes.calls.writeCurrent.length, 1);
  assert.equal(fakes.calls.close[0].acceptanceStatus, "accepted");
});

test("not_run validation cannot be accepted and is recorded as needs_review", async () => {
  const fakes = createFakes({
    taskEvidence: {
      async getEvidenceStatus() { return { ...structuredClone(BASE_STATUS), validation: { result: "not_run" }, evidence: { execution: "verified", git: "verified", validation: "not_run" } }; },
    },
  });
  const { app } = setup(fakes);
  const res = await invoke(app, "POST /api/evidence/close", { body: { acceptanceStatus: "accepted", userConfirmed: true } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "validation_required");
  assert.equal(fakes.calls.close.length, 0);
  assert.equal(fakes.calls.writeRecord.length, 0);
});

test("duplicate close returns the existing status without overwriting history", async () => {
  const fakes = createFakes({
    taskEvidence: {
      async getEvidenceStatus() { return { ...structuredClone(BASE_STATUS), acceptanceStatus: "accepted" }; },
    },
  });
  const { app } = setup(fakes);
  const res = await invoke(app, "POST /api/evidence/close", { body: { acceptanceStatus: "accepted", userConfirmed: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(fakes.calls.writeRecord.length, 0);
});
