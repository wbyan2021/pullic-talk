import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import projectRoutes from "../src/routes/project.js";
import { ProjectBoundaryError } from "../src/services/project-boundary.js";

const SAFE_PAYLOAD = {
  selected: true,
  inputPath: "/tmp/repo",
  resolvedPath: "/private/tmp/repo",
  repoRoot: "/private/tmp/repo",
  selectedAt: "2026-08-06T12:00:00.000Z",
  stale: false,
  inspection: {
    inspectedAt: "2026-08-06T12:00:00.000Z",
    branch: "main",
    detached: false,
    hasCommits: true,
    headCommit: { hash: "abc1234", date: "2026-08-06", subject: "base" },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    entries: [],
    truncated: false,
    remotes: [],
  },
  selectionSnapshotAt: "2026-08-06T12:00:00.000Z",
};

class FakeApp {
  constructor() { this.routes = new Map(); }
  register(method, path, handler) { this.routes.set(`${method} ${path}`, handler); }
  get(path, handler) { this.register("GET", path, handler); }
  post(path, handler) { this.register("POST", path, handler); }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.body = undefined;
    this.writableEnded = false;
  }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.writableEnded = true; return this; }
}

function createService(overrides = {}) {
  const calls = { status: 0, select: [], refresh: 0, clear: 0 };
  return {
    calls,
    async getStatus() { calls.status += 1; return { ...SAFE_PAYLOAD }; },
    async select(path) { calls.select.push(path); return { ...SAFE_PAYLOAD, inputPath: path }; },
    async refresh() { calls.refresh += 1; return { ...SAFE_PAYLOAD }; },
    async clear() { calls.clear += 1; return { selected: false }; },
    ...overrides,
  };
}

function setup(service = createService()) {
  const app = new FakeApp();
  projectRoutes(app, { projectBoundary: service });
  return { app, service };
}

async function invoke(app, key, { body } = {}) {
  const handler = app.routes.get(key);
  assert.ok(handler, `route ${key} must be registered`);
  const res = new FakeResponse();
  await handler({ body }, res);
  return res;
}

// ── 注册与成功路径 ──

test("registers the four project endpoints", () => {
  const { app } = setup();
  for (const key of [
    "GET /api/project/status",
    "POST /api/project/select",
    "POST /api/project/refresh",
    "POST /api/project/clear",
  ]) {
    assert.ok(app.routes.has(key), `${key} missing`);
  }
});

test("GET status passes service payload through", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "GET /api/project/status");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.project.selected, true);
  assert.equal(res.body.project.inspection.branch, "main");
  assert.equal(service.calls.status, 1);
});

test("POST select forwards path to service", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "POST /api/project/select", { body: { path: "/tmp/repo" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(service.calls.select, ["/tmp/repo"]);
});

test("POST select rejects missing or non-string path without calling service", async () => {
  for (const body of [undefined, {}, { path: 123 }, { path: null }]) {
    const { app, service } = setup();
    const res = await invoke(app, "POST /api/project/select", { body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "invalid_path");
    assert.equal(service.calls.select.length, 0);
  }
});

test("POST refresh and clear pass through", async () => {
  const { app, service } = setup();
  const refreshed = await invoke(app, "POST /api/project/refresh");
  assert.equal(refreshed.statusCode, 200);
  assert.equal(service.calls.refresh, 1);

  const cleared = await invoke(app, "POST /api/project/clear");
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.body.project.selected, false);
  assert.equal(service.calls.clear, 1);
});

// ── 错误映射 ──

const ERROR_MAPPING = [
  ["invalid_path", 400],
  ["path_not_found", 400],
  ["not_a_directory", 400],
  ["forbidden_root", 400],
  ["not_a_git_repo", 400],
  ["no_project_selected", 400],
  ["project_stale", 409],
  ["git_unavailable", 424],
  ["git_timeout", 504],
  ["git_failed", 502],
];

test("service errors map to stable codes and safe fixed messages", async () => {
  for (const [code, status] of ERROR_MAPPING) {
    const service = createService({
      async select() { throw new ProjectBoundaryError(code); },
    });
    const { app } = setup(service);
    const res = await invoke(app, "POST /api/project/select", { body: { path: "/tmp/repo" } });
    assert.equal(res.statusCode, status, `status for ${code}`);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, code);
    assert.equal(typeof res.body.message, "string");
    assert.ok(res.body.message.length > 0);
    assert.equal(typeof res.body.action, "string");
    assert.equal(typeof res.body.retryable, "boolean");
    assert.ok(!res.body.message.includes("/tmp/repo"), "message must not echo input");
  }
});

test("unknown errors become internal_error without leaking details", async () => {
  for (const error of [new Error("boom with secret"), new ProjectBoundaryError("mystery_code")]) {
    const service = createService({
      async getStatus() { throw error; },
    });
    const { app } = setup(service);
    const res = await invoke(app, "GET /api/project/status");
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.code, "internal_error");
    assert.ok(!JSON.stringify(res.body).includes("boom"), "raw error text must not leak");
    assert.ok(!JSON.stringify(res.body).includes("mystery_code"));
  }
});

// ── 字段白名单 ──

test("response payload is whitelisted even if service returns extra keys", async () => {
  const service = createService({
    async getStatus() {
      return { ...SAFE_PAYLOAD, __secret: "leak", inspection: { ...SAFE_PAYLOAD.inspection, env: process.env } };
    },
  });
  const { app } = setup(service);
  const res = await invoke(app, "GET /api/project/status");
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("__secret"));
  assert.ok(!text.includes("HOME"));
  assert.deepEqual(
    Object.keys(res.body.project).sort(),
    ["inspection", "inputPath", "repoRoot", "resolvedPath", "selected", "selectedAt", "selectionSnapshotAt", "stale"].sort()
  );
  assert.deepEqual(
    Object.keys(res.body.project.inspection).sort(),
    ["branch", "counts", "detached", "entries", "hasCommits", "headCommit", "inspectedAt", "remotes", "truncated"]
  );
});

test("unselected status returns minimal payload", async () => {
  const service = createService({
    async getStatus() { return { selected: false }; },
  });
  const { app } = setup(service);
  const res = await invoke(app, "GET /api/project/status");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.project, { selected: false });
});
