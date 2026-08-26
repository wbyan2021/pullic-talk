import test from "node:test";
import assert from "node:assert/strict";

import recoveryRoutes from "../src/routes/recovery.js";
import { TaskRecoveryError } from "../src/services/task-recovery.js";

class FakeApp {
  constructor() { this.routes = new Map(); }
  get(path, handler) { this.routes.set(`GET ${path}`, handler); }
  post(path, handler) { this.routes.set(`POST ${path}`, handler); }
}

class FakeResponse {
  constructor() { this.statusCode = 200; this.body = undefined; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; return this; }
}

function safePreview() {
  return {
    eligible: true,
    sourceTaskId: "task_failed",
    sourceState: "failed",
    reasonCode: "pi_not_authenticated",
    projectId: "project_001",
    branch: "codex/task",
    head: "abc1234",
    worktree: "modified",
    changedCount: 2,
    beforeHead: "base123",
    previewId: "preview_001",
    expiresAt: "2026-08-26T08:01:00.000Z",
    confirmationRequired: true,
    fileRollback: "not_included",
  };
}

function createService(overrides = {}) {
  const calls = { status: 0, preview: [], start: [] };
  const service = {
    async getStatus() { calls.status += 1; return { available: true, sourceTaskId: "task_failed", sourceState: "failed", reasonCode: "pi_not_authenticated", state: "previewable", secret: "no" }; },
    async preview({ taskId }) { calls.preview.push(taskId); return safePreview(); },
    async start(input) { calls.start.push(input); return { ok: true, sourceTaskId: input.taskId, taskId: "task_recovery", runId: "run_recovery" }; },
    ...overrides,
  };
  return { service, calls };
}

function setup(overrides = {}) {
  const app = new FakeApp();
  const fakes = createService(overrides);
  recoveryRoutes(app, { taskRecovery: fakes.service });
  return { app, ...fakes };
}

async function invoke(app, method, path, { params = {}, body = {} } = {}) {
  const handler = app.routes.get(`${method} ${path}`);
  assert.ok(handler, `${method} ${path} must be registered`);
  const res = new FakeResponse();
  await handler({ params, body }, res);
  return res;
}

test("registers the authenticated recovery endpoints", () => {
  const { app } = setup();
  for (const key of [
    "GET /api/recovery/status",
    "GET /api/recovery/:taskId/preview",
    "POST /api/recovery/:taskId/start",
  ]) assert.ok(app.routes.has(key), `${key} missing`);
});

test("status returns only the safe recovery summary", async () => {
  const { app } = setup();
  const res = await invoke(app, "GET", "/api/recovery/status");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    recovery: {
      available: true,
      sourceTaskId: "task_failed",
      sourceState: "failed",
      reasonCode: "pi_not_authenticated",
      state: "previewable",
    },
  });
  assert.ok(!JSON.stringify(res.body).includes("secret"));
});

test("status returns a safe empty state when recovery is unavailable", async () => {
  const { app } = setup({ async getStatus() { return { available: false, state: "stale", internalPath: "/private/project" }; } });
  const res = await invoke(app, "GET", "/api/recovery/status");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    recovery: { available: false, sourceTaskId: null, sourceState: null, reasonCode: null, state: "stale" },
  });
  assert.ok(!JSON.stringify(res.body).includes("private"));
});

test("preview validates the task path and projects only bounded fields", async () => {
  const { app, calls } = setup();
  const res = await invoke(app, "GET", "/api/recovery/:taskId/preview", { params: { taskId: "task_failed" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body.recovery).sort(), Object.keys(safePreview()).sort());
  assert.deepEqual(res.body.recovery, safePreview());
  assert.deepEqual(calls.preview, ["task_failed"]);
  assert.ok(!JSON.stringify(res.body).includes("task text"));
});

test("preview never forwards task text, output, commands, or path arrays", async () => {
  const { app } = setup({
    async preview() {
      return {
        ...safePreview(),
        task: "API_KEY=sk-test-12345678901234567890",
        output: "stderr secret",
        args: ["--unsafe"],
        cwd: "/private/project",
        changedPaths: ["secret.txt"],
      };
    },
  });
  const res = await invoke(app, "GET", "/api/recovery/:taskId/preview", { params: { taskId: "task_failed" } });
  const serialized = JSON.stringify(res.body);
  for (const value of ["API_KEY", "sk-test", "stderr", "--unsafe", "/private/project", "secret.txt"]) {
    assert.ok(!serialized.includes(value), `sensitive field leaked: ${value}`);
  }
});

test("start requires explicit confirmation and a preview handle", async () => {
  const { app, calls } = setup();
  const missing = await invoke(app, "POST", "/api/recovery/:taskId/start", { params: { taskId: "task_failed" }, body: {} });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.body.code, "recovery_preview_expired");

  const unconfirmed = await invoke(app, "POST", "/api/recovery/:taskId/start", {
    params: { taskId: "task_failed" },
    body: { previewId: "preview_001", confirmed: false },
  });
  assert.equal(unconfirmed.statusCode, 409);
  assert.equal(unconfirmed.body.code, "recovery_confirmation_required");
  assert.equal(calls.start.length, 0);

  const started = await invoke(app, "POST", "/api/recovery/:taskId/start", {
    params: { taskId: "task_failed" },
    body: { previewId: "preview_001", confirmed: true, projectPath: "/should/not/be-used" },
  });
  assert.equal(started.statusCode, 200);
  assert.deepEqual(started.body, { ok: true, recovery: { sourceTaskId: "task_failed", taskId: "task_recovery", runId: "run_recovery" } });
  assert.deepEqual(calls.start, [{ taskId: "task_failed", previewId: "preview_001", confirmed: true }]);
});

test("known recovery errors map to stable safe responses", async () => {
  const mapping = [
    ["recovery_not_eligible", 409],
    ["recovery_task_not_found", 404],
    ["recovery_payload_unavailable", 409],
    ["recovery_project_stale", 409],
    ["recovery_busy", 409],
    ["recovery_preview_expired", 409],
    ["recovery_confirmation_required", 409],
    ["recovery_start_failed", 502],
    ["recovery_internal_error", 500],
  ];
  for (const [code, status] of mapping) {
    const { app } = setup({ async preview() { throw new TaskRecoveryError(code, { retryable: code.includes("internal") }); } });
    const res = await invoke(app, "GET", "/api/recovery/:taskId/preview", { params: { taskId: "task_failed" } });
    assert.equal(res.statusCode, status, `status for ${code}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, code);
    assert.equal(typeof res.body.message, "string");
    assert.equal(typeof res.body.action, "string");
    assert.equal(typeof res.body.retryable, "boolean");
    assert.ok(!JSON.stringify(res.body).includes("task_failed"));
  }
});

test("unknown recovery errors become an internal error without details", async () => {
  const { app } = setup({ async getStatus() { throw new Error("secret task path"); } });
  const res = await invoke(app, "GET", "/api/recovery/status");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    ok: false,
    code: "recovery_internal_error",
    message: "恢复服务暂时不可用，请重新加载后重试。",
    action: "重新加载页面",
    retryable: true,
  });
  assert.ok(!JSON.stringify(res.body).includes("secret task path"));
});
