import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import executionRoutes from "../src/routes/execution.js";
import { PiExecutorError } from "../src/services/pi-executor.js";

const SAFE_EXECUTION = {
  state: "exited",
  runId: "run_1",
  startedAt: "2026-08-12T12:00:00.000Z",
  exitCode: 0,
  truncated: false,
  durationMs: 1234,
  output: "hello",
  task: "列出文件",
  lastError: null,
};

const EXECUTION_KEYS = ["state", "runId", "startedAt", "exitCode", "truncated", "durationMs", "output", "task", "lastError"];

function createFakeExecutor(overrides = {}) {
  const calls = { status: 0, start: [], stop: 0 };
  const events = [];
  const listeners = new Set();
  function emit(type, data) {
    events.push({ type, data });
    for (const listener of [...listeners]) listener(type, data);
  }
  return {
    calls,
    events,
    listeners,
    async getStatus() {
      calls.status += 1;
      return overrides.status ?? { ...SAFE_EXECUTION };
    },
    async start(task) {
      calls.start.push(task);
      if (overrides.startError) throw overrides.startError;
      emit("start", { runId: "run_1", startedAt: SAFE_EXECUTION.startedAt });
      emit("chunk", { text: "hello" });
      emit("done", { state: "exited", exitCode: 0, truncated: false, durationMs: 1234 });
      return "run_1";
    },
    stop() {
      calls.stop += 1;
      return overrides.stopStatus ?? { ...SAFE_EXECUTION, state: "stopped" };
    },
    checkAuth: overrides.checkAuth ?? (async () => ({ ready: true })),
    subscribe(listener) {
      for (const event of events) listener(event.type, event.data);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

class FakeApp {
  constructor() { this.routes = new Map(); }
  get(path, handler) { this.routes.set(`GET ${path}`, handler); }
  post(path, handler) { this.routes.set(`POST ${path}`, handler); }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.body = undefined;
    this.writes = [];
    this.writableEnded = false;
  }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.writableEnded = true; return this; }
  writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; }
  write(text) { this.writes.push(text); return true; }
  end() { this.writableEnded = true; }
}

function setup(executor = createFakeExecutor()) {
  const app = new FakeApp();
  executionRoutes(app, { piExecutor: executor });
  return { app, executor };
}

function setupWithEvidence(taskEvidence, executor = null) {
  const app = new FakeApp();
  executionRoutes(app, { piExecutor: executor, taskEvidence });
  return { app, taskEvidence };
}

async function invoke(app, key, { body } = {}) {
  const handler = app.routes.get(key);
  assert.ok(handler, `route ${key} must be registered`);
  const res = new FakeResponse();
  await handler({ body }, res);
  return res;
}

// ── 注册与成功路径 ──

test("registers the three execution endpoints", () => {
  const { app } = setup();
  for (const key of [
    "GET /api/project/execution/status",
    "POST /api/project/execution/start",
    "POST /api/project/execution/stop",
  ]) {
    assert.ok(app.routes.has(key), `${key} missing`);
  }
});

test("GET status passes whitelisted execution state through", async () => {
  const executor = createFakeExecutor({ status: { ...SAFE_EXECUTION, __secret: "leak", events: [{ type: "chunk" }] } });
  const { app } = setup(executor);
  const res = await invoke(app, "GET /api/project/execution/status");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(Object.keys(res.body.execution).sort(), [...EXECUTION_KEYS].sort());
  assert.equal(res.body.execution.state, "exited");
  assert.ok(!("events" in res.body.execution), "replay buffer must not be exposed");
  assert.ok(!JSON.stringify(res.body).includes("__secret"));
});

test("GET status whitelists lastError to code and retryable only", async () => {
  const executor = createFakeExecutor({
    status: { ...SAFE_EXECUTION, state: "error", lastError: { code: "timeout", retryable: true, secret: "x" } },
  });
  const { app } = setup(executor);
  const res = await invoke(app, "GET /api/project/execution/status");
  assert.deepEqual(res.body.execution.lastError, { code: "timeout", retryable: true });
});

// ── start 输入校验与错误映射 ──

test("POST start rejects missing or invalid task without calling executor", async () => {
  for (const body of [undefined, {}, { task: 123 }, { task: "" }, { task: "   " }]) {
    const { app, executor } = setup();
    const res = await invoke(app, "POST /api/project/execution/start", { body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "invalid_task");
    assert.equal(executor.calls.start.length, 0);
  }
});

const ERROR_MAPPING = [
  ["invalid_task", 400],
  ["no_project_selected", 400],
  ["project_stale", 409],
  ["pi_not_found", 424],
  ["pi_not_authenticated", 424],
  ["busy", 409],
  ["spawn_failed", 502],
  ["timeout", 504],
];

test("executor errors map to stable codes and safe fixed messages", async () => {
  for (const [code, status] of ERROR_MAPPING) {
    const executor = createFakeExecutor({ startError: new PiExecutorError(code) });
    const { app } = setup(executor);
    const res = await invoke(app, "POST /api/project/execution/start", { body: { task: "做点事" } });
    assert.equal(res.statusCode, status, `status for ${code}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, code);
    assert.equal(typeof res.body.message, "string");
    assert.ok(res.body.message.length > 0);
    assert.equal(typeof res.body.action, "string");
    assert.equal(typeof res.body.retryable, "boolean");
    assert.ok(!res.body.message.includes("做点事"), "message must not echo the task");
  }
});

test("unknown errors become internal_error without leaking details", async () => {
  for (const error of [new Error("boom with secret"), new PiExecutorError("mystery_code")]) {
    const executor = createFakeExecutor({ startError: error });
    const { app } = setup(executor);
    const res = await invoke(app, "POST /api/project/execution/start", { body: { task: "做点事" } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, "internal_error");
    assert.ok(!JSON.stringify(res.body).includes("boom"));
    assert.ok(!JSON.stringify(res.body).includes("mystery_code"));
  }
});

// ── SSE 流 ──

test("POST start success opens an SSE stream with buffered and live events", async () => {
  const { app, executor } = setup();
  const res = await invoke(app, "POST /api/project/execution/start", { body: { task: "列出文件" } });

  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers["Content-Type"]).includes("text/event-stream"));
  assert.deepEqual(executor.calls.start, ["列出文件"]);

  const written = res.writes.join("");
  assert.ok(written.includes("event: start"), "replayed start event missing");
  assert.ok(written.includes("event: chunk"));
  assert.ok(written.includes("event: done"));
  assert.ok(written.includes('"exitCode":0'));
});

test("client close unsubscribes from events without stopping the executor", async () => {
  const { app, executor } = setup();
  const res = await invoke(app, "POST /api/project/execution/start", { body: { task: "列出文件" } });

  assert.ok(res.listenerCount("close") > 0, "route must react to client disconnect");
  res.emit("close");
  assert.equal(executor.calls.stop, 0, "disconnect must not stop the running pi");
});

test("live events after subscribe are streamed too", async () => {
  const executor = createFakeExecutor();
  // start 不立即发 done：模拟长任务
  executor.start = async (task) => {
    executor.calls.start.push(task);
    return "run_1";
  };
  const { app } = setup(executor);
  const res = await invoke(app, "POST /api/project/execution/start", { body: { task: "长任务" } });

  // 订阅建立后由 executor 侧广播事件
  for (const listener of [...executor.listeners]) listener("chunk", { text: "live-chunk" });
  const written = res.writes.join("");
  assert.ok(written.includes("live-chunk"));
});

// ── stop ──

test("POST stop passes executor status through", async () => {
  const { app, executor } = setup();
  const res = await invoke(app, "POST /api/project/execution/stop");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.execution.state, "stopped");
  assert.equal(executor.calls.stop, 1);
});

test("execution routes prefer the task evidence coordinator when provided", async () => {
  const calls = { start: [], stop: 0 };
  const events = [{ type: "start", data: { runId: "task-run" } }, { type: "done", data: { state: "exited", exitCode: 0 } }];
  const taskEvidence = {
    async getStatus() { return { ...SAFE_EXECUTION, taskId: "task_001", projectId: "project_001" }; },
    async start(task) { calls.start.push(task); return "task-run"; },
    async stop() { calls.stop += 1; return { ...SAFE_EXECUTION, state: "stopped", taskId: "task_001", projectId: "project_001" }; },
    subscribe(listener) { for (const event of events) listener(event.type, event.data); return () => {}; },
  };
  const { app } = setupWithEvidence(taskEvidence, {
    async start() { throw new Error("must not be used"); },
    async stop() { throw new Error("must not be used"); },
  });
  const status = await invoke(app, "GET /api/project/execution/status");
  assert.equal(status.body.execution.taskId, "task_001");
  await invoke(app, "POST /api/project/execution/start", { body: { task: "证据任务" } });
  await invoke(app, "POST /api/project/execution/stop");
  assert.deepEqual(calls.start, ["证据任务"]);
  assert.equal(calls.stop, 1);
});
