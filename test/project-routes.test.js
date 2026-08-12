import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import projectRoutes from "../src/routes/project.js";
import { ProjectBoundaryError } from "../src/services/project-boundary.js";

const SAFE_PROJECT = {
  id: "abc123def456",
  inputPath: "/tmp/repo",
  resolvedPath: "/private/tmp/repo",
  repoRoot: "/private/tmp/repo",
  selectedAt: "2026-08-12T12:00:00.000Z",
  stale: false,
  inspection: {
    inspectedAt: "2026-08-12T12:00:00.000Z",
    branch: "main",
    detached: false,
    hasCommits: true,
    headCommit: { hash: "abc1234", date: "2026-08-12", subject: "base" },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    entries: [],
    truncated: false,
    remotes: [],
  },
  selectionSnapshotAt: "2026-08-12T12:00:00.000Z",
};

const PROJECT_KEYS = ["id", "inputPath", "resolvedPath", "repoRoot", "selectedAt", "stale", "inspection", "selectionSnapshotAt"];

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
  const calls = { status: 0, select: [], activate: [], refresh: [], clear: [] };
  return {
    calls,
    async getStatus() {
      calls.status += 1;
      return { projects: [{ ...SAFE_PROJECT }], activeProjectId: SAFE_PROJECT.id, active: { ...SAFE_PROJECT } };
    },
    async select(path) { calls.select.push(path); return { ...SAFE_PROJECT, inputPath: path }; },
    async setActive(id) { calls.activate.push(id); return { activeProjectId: id }; },
    async refresh(id) { calls.refresh.push(id); return { ...SAFE_PROJECT }; },
    async clear(id) { calls.clear.push(id); return { removed: true, id }; },
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

test("registers the five project endpoints", () => {
  const { app } = setup();
  for (const key of [
    "GET /api/project/status",
    "POST /api/project/select",
    "POST /api/project/activate",
    "POST /api/project/refresh",
    "POST /api/project/clear",
  ]) {
    assert.ok(app.routes.has(key), `${key} missing`);
  }
});

test("GET status returns the project list and activeProjectId", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "GET /api/project/status");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.projects.length, 1);
  assert.equal(res.body.projects[0].id, SAFE_PROJECT.id);
  assert.equal(res.body.projects[0].inspection.branch, "main");
  assert.equal(res.body.activeProjectId, SAFE_PROJECT.id);
  assert.ok(!("project" in res.body), "v2 status has no single-project field");
  assert.ok(!("active" in res.body), "active payload is not duplicated in the response");
  assert.equal(service.calls.status, 1);
});

test("GET status with no projects returns an empty list", async () => {
  const service = createService({
    async getStatus() { return { projects: [], activeProjectId: null, active: null }; },
  });
  const { app } = setup(service);
  const res = await invoke(app, "GET /api/project/status");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, projects: [], activeProjectId: null });
});

test("POST select forwards path to service and returns the single project", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "POST /api/project/select", { body: { path: "/tmp/repo" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.project.id, SAFE_PROJECT.id);
  assert.equal(res.body.project.inputPath, "/tmp/repo");
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

test("POST activate forwards id and returns activeProjectId", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "POST /api/project/activate", { body: { id: "abc123def456" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, activeProjectId: "abc123def456" });
  assert.deepEqual(service.calls.activate, ["abc123def456"]);
});

test("POST activate rejects missing or non-string id without calling service", async () => {
  for (const body of [undefined, {}, { id: 123 }, { id: "" }, { id: "   " }]) {
    const { app, service } = setup();
    const res = await invoke(app, "POST /api/project/activate", { body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.code, "invalid_id");
    assert.equal(service.calls.activate.length, 0);
  }
});

test("POST refresh and clear forward an optional id to the service", async () => {
  const { app, service } = setup();

  const refreshed = await invoke(app, "POST /api/project/refresh", { body: { id: "abc123def456" } });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(refreshed.body.project.id, SAFE_PROJECT.id);
  assert.deepEqual(service.calls.refresh, ["abc123def456"]);

  const cleared = await invoke(app, "POST /api/project/clear", { body: { id: "abc123def456" } });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(cleared.body, { ok: true });
  assert.deepEqual(service.calls.clear, ["abc123def456"]);
});

test("POST refresh and clear work without an id (active project fallback)", async () => {
  const { app, service } = setup();
  await invoke(app, "POST /api/project/refresh");
  await invoke(app, "POST /api/project/clear");
  assert.deepEqual(service.calls.refresh, [undefined]);
  assert.deepEqual(service.calls.clear, [undefined]);
});

test("POST refresh and clear reject a non-string id without calling service", async () => {
  for (const key of ["POST /api/project/refresh", "POST /api/project/clear"]) {
    const { app, service } = setup();
    const res = await invoke(app, key, { body: { id: 42 } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "invalid_id");
    assert.equal(service.calls.refresh.length, 0);
    assert.equal(service.calls.clear.length, 0);
  }
});

// ── 错误映射 ──

const ERROR_MAPPING = [
  ["invalid_path", 400],
  ["path_not_found", 400],
  ["not_a_directory", 400],
  ["forbidden_root", 400],
  ["not_a_git_repo", 400],
  ["no_project_selected", 400],
  ["project_not_found", 404],
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

test("activate surfaces project_not_found as 404", async () => {
  const service = createService({
    async setActive() { throw new ProjectBoundaryError("project_not_found"); },
  });
  const { app } = setup(service);
  const res = await invoke(app, "POST /api/project/activate", { body: { id: "missing00000" } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "project_not_found");
  assert.ok(!JSON.stringify(res.body).includes("missing00000"), "raw id must not be echoed");
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

test("list items are whitelisted even if the service returns extra keys", async () => {
  const service = createService({
    async getStatus() {
      return {
        projects: [{ ...SAFE_PROJECT, __secret: "leak", inspection: { ...SAFE_PROJECT.inspection, env: process.env } }],
        activeProjectId: SAFE_PROJECT.id,
        active: null,
      };
    },
  });
  const { app } = setup(service);
  const res = await invoke(app, "GET /api/project/status");
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes("__secret"));
  assert.ok(!text.includes("HOME"));
  assert.deepEqual(Object.keys(res.body.projects[0]).sort(), [...PROJECT_KEYS].sort());
  assert.deepEqual(
    Object.keys(res.body.projects[0].inspection).sort(),
    ["branch", "counts", "detached", "entries", "hasCommits", "headCommit", "inspectedAt", "remotes", "truncated"]
  );
});
