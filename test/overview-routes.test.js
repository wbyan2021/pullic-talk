import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import overviewRoutes from "../src/routes/overview.js";

const PROJECT = {
  id: "project_001",
  repoRoot: "/tmp/project",
  stale: false,
  inspection: {
    branch: "main",
    headCommit: { hash: "abc1234", date: "2026-08-26", subject: "base" },
    counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
    entries: [{ status: "M", path: "secret.txt" }],
    remotes: ["https://example.invalid/repo.git"],
    truncated: false,
  },
  handoff: {
    enabled: true,
    state: "ready",
    currentPath: "docs/ai-ops/NOW.md",
    recordsPath: "docs/ai-ops/records",
    fileState: { agentsPointer: "managed", current: "managed", records: "present", state: "ready" },
  },
};

const EVIDENCE = {
  taskId: "task_001",
  projectId: "project_001",
  runId: "run_001",
  state: "exited",
  executionStatus: "exited",
  before: { branch: "main", head: "abc1234", worktree: "modified", changedPaths: ["before-secret.txt"], truncated: false },
  after: { branch: "codex/s05", head: "def5678", worktree: "modified", changedPaths: ["after-secret.txt"], truncated: false },
  gitEvidence: { certainty: "observed", causality: "not_proven", newPaths: ["new-secret.txt"], changedPaths: [], preexistingPaths: [] },
  evidence: { execution: "verified", git: "verified", validation: "passed" },
  validation: {
    result: "passed", exitCode: 0, durationMs: 123, withheld: false, truncated: false,
    executable: "npm", args: ["test"], cwd: "/tmp/project", output: "raw validation output",
  },
  acceptanceStatus: "needs_review",
  task: "do not return this task text",
  lastError: null,
};

class FakeApp {
  constructor() { this.routes = new Map(); }
  get(path, handler) { this.routes.set(`GET ${path}`, handler); }
}

class FakeResponse extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = undefined; this.writableEnded = false; }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.writableEnded = true; return this; }
}

function idleEvidence() {
  return {
    taskId: null,
    projectId: null,
    runId: null,
    state: "idle",
    executionStatus: "idle",
    before: null,
    after: null,
    gitEvidence: null,
    validation: { result: "not_run" },
    evidence: { execution: "unknown", git: "unknown", validation: "not_run" },
    acceptanceStatus: "pending",
    task: null,
    lastError: null,
  };
}

function createFakes(overrides = {}) {
  const calls = { project: 0, evidence: 0, execution: 0, handoff: [] };
  const projectBoundary = {
    async getStatus() {
      calls.project += 1;
      return { projects: [{ ...PROJECT }], activeProjectId: PROJECT.id, active: structuredClone(PROJECT) };
    },
    ...overrides.projectBoundary,
  };
  const taskEvidence = {
    async getEvidenceStatus() { calls.evidence += 1; return structuredClone(EVIDENCE); },
    async getStatus() { calls.execution += 1; return { state: "exited", runId: "run_001", startedAt: "2026-08-26T00:00:00.000Z", durationMs: 123, task: "do not return", output: "raw output", taskId: "task_001", projectId: "project_001", lastError: null }; },
    ...overrides.taskEvidence,
  };
  const aiHandoff = {
    async readSummary(input) { calls.handoff.push(input); return { state: "ready", taskStatus: "needs_review", nextAction: "先运行验收测试" }; },
    ...overrides.aiHandoff,
  };
  return { projectBoundary, taskEvidence, aiHandoff, calls };
}

function setup(fakes = createFakes()) {
  const app = new FakeApp();
  overviewRoutes(app, fakes);
  return { app, ...fakes };
}

async function invoke(app) {
  const handler = app.routes.get("GET /api/overview");
  assert.ok(handler, "overview route must be registered");
  const res = new FakeResponse();
  await handler({}, res);
  return res;
}

test("registers the authenticated read-only overview endpoint", () => {
  const { app } = setup();
  assert.ok(app.routes.has("GET /api/overview"));
});

test("projects active project, execution, evidence and next action with a strict whitelist", async () => {
  const { app, calls } = setup();
  const res = await invoke(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const { overview } = res.body;
  assert.deepEqual(overview.project, {
    selected: true,
    activeProjectId: "project_001",
    active: {
      id: "project_001",
      repoRoot: "/tmp/project",
      stale: false,
      inspection: {
        branch: "main",
        headCommit: { hash: "abc1234", date: "2026-08-26", subject: "base" },
        counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
        truncated: false,
      },
      handoff: {
        state: "ready",
        currentPath: "docs/ai-ops/NOW.md",
        recordsPath: "docs/ai-ops/records",
        fileState: { agentsPointer: "managed", current: "managed", records: "present", state: "ready" },
      },
    },
  });
  assert.deepEqual(overview.execution, {
    available: true,
    state: "exited",
    runId: "run_001",
    startedAt: "2026-08-26T00:00:00.000Z",
    durationMs: 123,
    taskId: "task_001",
    projectId: "project_001",
    lastError: null,
  });
  assert.equal(overview.evidence.available, true);
  assert.equal(overview.evidence.validation.result, "passed");
  assert.deepEqual(overview.evidence.before, { branch: "main", head: "abc1234", worktree: "modified", changedCount: 1, truncated: false });
  assert.deepEqual(overview.evidence.after, { branch: "codex/s05", head: "def5678", worktree: "modified", changedCount: 1, truncated: false });
  assert.deepEqual(overview.evidence.gitEvidence, { certainty: "observed", causality: "not_proven", newCount: 1, changedCount: 0, preexistingCount: 0 });
  assert.deepEqual(overview.nextAction, { text: "先运行验收测试", source: "docs/ai-ops/NOW.md", state: "ready" });
  assert.deepEqual(calls.handoff, [{ repoRoot: "/tmp/project" }]);
});

test("returns safe empty states when there is no active project", async () => {
  const fakes = createFakes({
    projectBoundary: async () => {},
  });
  fakes.projectBoundary.getStatus = async () => ({ projects: [], activeProjectId: null, active: null });
  const { app, calls } = setup(fakes);
  const res = await invoke(app);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.overview.project, { selected: false, activeProjectId: null, active: null });
  assert.deepEqual(res.body.overview.execution, { available: false, state: "idle", runId: null, startedAt: null, durationMs: null, taskId: null, projectId: null, lastError: null });
  assert.equal(res.body.overview.evidence.available, false);
  assert.deepEqual(res.body.overview.nextAction, { text: null, source: null, state: "unavailable" });
  assert.equal(calls.handoff.length, 0);
});

test("does not expose task text, output, stderr, command arguments, cwd, or path arrays", async () => {
  const { app } = setup();
  const res = await invoke(app);
  const serialized = JSON.stringify(res.body);
  for (const secret of ["do not return this task text", "raw output", "raw validation output", "stderr", "before-secret.txt", "after-secret.txt", "new-secret.txt", "/tmp/project", "npm"]) {
    if (secret === "/tmp/project") continue;
    assert.ok(!serialized.includes(secret), `sensitive field leaked: ${secret}`);
  }
  assert.ok(!("task" in res.body.overview.execution));
  assert.ok(!("output" in res.body.overview.execution));
  assert.ok(!("args" in res.body.overview.evidence.validation));
  assert.ok(!("cwd" in res.body.overview.evidence.validation));
  assert.ok(!Array.isArray(res.body.overview.evidence.before?.changedPaths));
});

test("keeps handoff unavailable when the managed summary cannot be read", async () => {
  const fakes = createFakes({ aiHandoff: { async readSummary() { return { state: "unavailable", taskStatus: null, nextAction: null }; } } });
  const { app } = setup(fakes);
  const res = await invoke(app);
  assert.deepEqual(res.body.overview.nextAction, { text: null, source: "docs/ai-ops/NOW.md", state: "unavailable" });
});

test("maps service failures to a stable internal error without raw details", async () => {
  const fakes = createFakes({ projectBoundary: { async getStatus() { throw new Error("secret internal path"); } } });
  const { app } = setup(fakes);
  const res = await invoke(app);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    ok: false,
    code: "internal_error",
    message: "总览暂时不可用，请重新加载后重试。",
    action: "重新加载页面",
    retryable: true,
  });
  assert.ok(!JSON.stringify(res.body).includes("secret internal path"));
});
