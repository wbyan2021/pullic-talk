import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { createGitInspector } from "../src/services/git-inspector.js";
import {
  createProjectBoundary,
  ProjectBoundaryError,
} from "../src/services/project-boundary.js";

// ── fixture helpers（只在 os.tmpdir() 内创建） ──

const GIT_OPTS = [
  "-c", "user.name=s02b-test",
  "-c", "user.email=s02b@test.local",
  "-c", "init.defaultBranch=main",
];

function git(cwd, ...args) {
  const r = spawnSync("git", [...GIT_OPTS, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeTmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "s02b-boundary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t) {
  const dir = makeTmpDir(t);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "file.txt"), "v1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base commit");
  return dir;
}

function projectId(repoRoot) {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
}

function makeBoundary(t, { inspector = createGitInspector() } = {}) {
  const dir = makeTmpDir(t);
  const statePath = join(dir, "projects.local.json");
  let clock = 1_700_000_000_000;
  const service = createProjectBoundary({
    inspector,
    statePath,
    now: () => clock,
  });
  return { service, statePath, dir, advance: (ms) => { clock += ms; } };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof ProjectBoundaryError,
      `expected ProjectBoundaryError, got ${error?.constructor?.name}: ${error?.message}`
    );
    return error.code;
  }
  assert.fail("expected rejection");
}

const PAYLOAD_KEYS = ["id", "inputPath", "resolvedPath", "repoRoot", "selectedAt", "stale", "inspection", "selectionSnapshotAt"];
const INSPECTION_KEYS = ["inspectedAt", "branch", "detached", "hasCommits", "headCommit", "counts", "entries", "truncated", "remotes"];
const EMPTY_STATUS = { projects: [], activeProjectId: null, active: null };

// ── 空状态与损坏降级 ──

test("getStatus before any selection reports empty v2 status", async (t) => {
  const { service } = makeBoundary(t);
  assert.deepEqual(await service.getStatus(), EMPTY_STATUS);
});

test("corrupted state file degrades to empty v2 status without throwing", async (t) => {
  const { service, statePath } = makeBoundary(t);
  writeFileSync(statePath, "{ this is not json");
  assert.deepEqual(await service.getStatus(), EMPTY_STATUS);
});

// ── v1 → v2 迁移 ──

function makeV1Fixture(t) {
  const repo = makeRepo(t);
  const inspection = {
    inspectedAt: "2026-08-10T00:00:00.000Z",
    branch: "main",
    detached: false,
    hasCommits: true,
    headCommit: { hash: "abc1234", date: "2026-08-10", subject: "base commit" },
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    entries: [],
    truncated: false,
    remotes: [],
  };
  const record = {
    inputPath: repo,
    resolvedPath: repo,
    repoRoot: repo,
    selectedAt: "2026-08-10T00:00:00.000Z",
    selectionSnapshot: structuredClone(inspection),
    lastInspection: structuredClone(inspection),
  };
  return { repo, record };
}

test("v1 state file migrates to v2 without losing any field", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const { record } = makeV1Fixture(t);
  writeFileSync(statePath, JSON.stringify({ version: 1, project: record }, null, 2));

  const status = await service.getStatus();
  assert.equal(status.projects.length, 1);
  const migrated = status.projects[0];
  const id = projectId(record.repoRoot);
  assert.equal(migrated.id, id);
  assert.equal(migrated.inputPath, record.inputPath);
  assert.equal(migrated.resolvedPath, record.resolvedPath);
  assert.equal(migrated.repoRoot, record.repoRoot);
  assert.equal(migrated.selectedAt, record.selectedAt, "selectedAt must survive migration");
  assert.deepEqual(migrated.inspection, record.lastInspection, "lastInspection must survive migration");
  assert.equal(status.activeProjectId, id, "migrated single project becomes active");
  assert.equal(status.active.id, id);

  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.version, 2, "state file must be rewritten as v2");
  assert.equal(stored.activeProjectId, id);
  assert.ok(stored.projects[id].selectionSnapshot, "selection snapshot must be preserved for S05");
  assert.deepEqual(stored.projects[id].lastInspection, record.lastInspection);
});

// ── 多项目录入与幂等 ──

test("select persists v2 state and returns the project payload", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repo = makeRepo(t);

  const payload = await service.select(repo);
  assert.equal(payload.id, projectId(payload.repoRoot));
  assert.equal(payload.inputPath, repo);
  assert.equal(payload.stale, false);
  assert.equal(payload.inspection.branch, "main");
  assert.ok(payload.selectedAt);
  assert.ok(payload.selectionSnapshotAt);
  assert.ok(!("selectionSnapshot" in payload), "raw snapshot must stay server-side");
  assert.ok(!("selected" in payload), "v2 payload has no selected flag");

  assert.ok(existsSync(statePath));
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.version, 2);
  assert.ok(stored.projects[payload.id]);
  assert.equal(stored.activeProjectId, null, "select must not change the active project");
});

test("multiple projects coexist and list in selectedAt order", async (t) => {
  const { service, advance } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);

  const first = await service.select(repoA);
  advance(60_000);
  const second = await service.select(repoB);

  const status = await service.getStatus();
  assert.equal(status.projects.length, 2);
  assert.deepEqual(status.projects.map((p) => p.id), [first.id, second.id]);
  assert.equal(status.activeProjectId, null);
  assert.equal(status.active, null);
});

test("re-selecting the same repoRoot updates the entry in place", async (t) => {
  const { service, advance } = makeBoundary(t);
  const repo = makeRepo(t);

  const first = await service.select(repo);
  advance(60_000);
  const second = await service.select(repo);

  const status = await service.getStatus();
  assert.equal(status.projects.length, 1, "same repoRoot must stay a single entry");
  assert.equal(second.id, first.id);
  assert.notEqual(second.selectedAt, first.selectedAt, "selectedAt refreshes on re-select");
});

test("select failures pass through inspector codes and write nothing", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const plainDir = makeTmpDir(t);

  assert.equal(await rejectCode(service.select(plainDir)), "not_a_git_repo");
  assert.equal(await rejectCode(service.select(join(plainDir, "missing"))), "path_not_found");
  assert.ok(!existsSync(statePath), "no state file may be written on failed select");
  assert.deepEqual(await service.getStatus(), EMPTY_STATUS);
});

// ── 活动项目 ──

test("setActive marks a project active; status exposes the active payload", async (t) => {
  const { service } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  const first = await service.select(repoA);
  const second = await service.select(repoB);

  const result = await service.setActive(second.id);
  assert.equal(result.activeProjectId, second.id);

  const status = await service.getStatus();
  assert.equal(status.activeProjectId, second.id);
  assert.equal(status.active.id, second.id);
  assert.equal(status.active.repoRoot, second.repoRoot);
});

test("setActive with unknown id rejects project_not_found", async (t) => {
  const { service } = makeBoundary(t);
  await service.select(makeRepo(t));
  assert.equal(await rejectCode(service.setActive("000000000000")), "project_not_found");
});

test("handoff enablement is explicit, persisted, and absent after selection alone", async (t) => {
  const { service, statePath, dir } = makeBoundary(t);
  const repo = makeRepo(t);
  const selected = await service.select(repo);
  assert.ok(!("handoff" in (await service.getStatus()).projects[0]));
  await service.setActive(selected.id);
  const enabled = await service.enableHandoff();
  assert.equal(enabled.handoff.enabled, true);
  assert.equal(enabled.handoff.currentPath, "docs/ai-ops/NOW.md");
  assert.equal((await service.getHandoff()).enabled, true);

  const restarted = createProjectBoundary({ inspector: createGitInspector(), statePath });
  const status = await restarted.getStatus();
  assert.equal(status.active.handoff.enabled, true);
  assert.equal(status.active.handoff.recordsPath, "docs/ai-ops/records");
  assert.ok(dir);
});

// ── refresh ──

test("refresh without active project and without id rejects no_project_selected", async (t) => {
  const { service } = makeBoundary(t);
  assert.equal(await rejectCode(service.refresh()), "no_project_selected");
});

test("refresh(id) updates only that project and keeps selectedAt", async (t) => {
  const { service, statePath, advance } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  const first = await service.select(repoA);
  const other = await service.select(repoB);

  advance(60_000);
  const refreshed = await service.refresh(first.id);
  assert.equal(refreshed.id, first.id);
  assert.equal(refreshed.selectedAt, first.selectedAt);
  assert.notEqual(refreshed.inspection.inspectedAt, first.inspection.inspectedAt);

  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.projects[first.id].selectedAt, first.selectedAt);
  assert.ok(stored.projects[other.id], "other project untouched");
});

test("refresh() without id falls back to the active project", async (t) => {
  const { service, advance } = makeBoundary(t);
  const repo = makeRepo(t);
  const first = await service.select(repo);
  await service.setActive(first.id);

  advance(60_000);
  const refreshed = await service.refresh();
  assert.equal(refreshed.id, first.id);
  assert.notEqual(refreshed.inspection.inspectedAt, first.inspection.inspectedAt);
});

test("refresh with unknown id rejects project_not_found", async (t) => {
  const { service } = makeBoundary(t);
  await service.select(makeRepo(t));
  assert.equal(await rejectCode(service.refresh("000000000000")), "project_not_found");
});

test("refresh on a deleted repo rejects project_stale", async (t) => {
  const { service } = makeBoundary(t);
  const repo = makeRepo(t);
  const payload = await service.select(repo);
  rmSync(repo, { recursive: true, force: true });
  assert.equal(await rejectCode(service.refresh(payload.id)), "project_stale");
});

// ── clear ──

test("clear(id) removes only that project and keeps the state file as v2", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  const drop = await service.select(repoA);
  const keep = await service.select(repoB);

  const result = await service.clear(drop.id);
  assert.equal(result.removed, true);

  const status = await service.getStatus();
  assert.equal(status.projects.length, 1);
  assert.equal(status.projects[0].id, keep.id);

  assert.ok(existsSync(statePath), "state file persists as canonical v2 empty-able map");
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.version, 2);
});

test("clearing the active project resets activeProjectId to null", async (t) => {
  const { service } = makeBoundary(t);
  const repo = makeRepo(t);
  const payload = await service.select(repo);
  await service.setActive(payload.id);

  await service.clear(payload.id);
  const status = await service.getStatus();
  assert.equal(status.activeProjectId, null);
  assert.equal(status.active, null);
  assert.equal(status.projects.length, 0);
});

test("clear() without id falls back to the active project", async (t) => {
  const { service } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  const drop = await service.select(repoA);
  const keep = await service.select(repoB);
  await service.setActive(drop.id);

  await service.clear();
  const status = await service.getStatus();
  assert.deepEqual(status.projects.map((p) => p.id), [keep.id]);
  assert.equal(status.activeProjectId, null);
});

test("clear without active project and without id rejects no_project_selected", async (t) => {
  const { service } = makeBoundary(t);
  assert.equal(await rejectCode(service.clear()), "no_project_selected");
});

test("clear with unknown id rejects project_not_found", async (t) => {
  const { service } = makeBoundary(t);
  await service.select(makeRepo(t));
  assert.equal(await rejectCode(service.clear("000000000000")), "project_not_found");
});

// ── 失效检测与持久化 ──

test("stale is computed per project", async (t) => {
  const { service } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);
  const gone = await service.select(repoA);
  const alive = await service.select(repoB);

  rmSync(repoA, { recursive: true, force: true });

  const status = await service.getStatus();
  const byId = Object.fromEntries(status.projects.map((p) => [p.id, p]));
  assert.equal(byId[gone.id].stale, true);
  assert.equal(byId[alive.id].stale, false);
});

test("projects survive service restart via state file", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repo = makeRepo(t);
  const original = await service.select(repo);
  await service.setActive(original.id);

  const second = createProjectBoundary({
    inspector: createGitInspector(),
    statePath,
  });
  const status = await second.getStatus();
  assert.equal(status.projects.length, 1);
  assert.equal(status.projects[0].repoRoot, original.repoRoot);
  assert.equal(status.projects[0].selectedAt, original.selectedAt);
  assert.equal(status.activeProjectId, original.id);
});

// ── 输出白名单 ──

test("payload exposes only whitelisted keys", async (t) => {
  const { service } = makeBoundary(t);
  const repo = makeRepo(t);
  const payload = await service.select(repo);
  assert.deepEqual(Object.keys(payload).sort(), [...PAYLOAD_KEYS].sort());
  assert.deepEqual(Object.keys(payload.inspection).sort(), [...INSPECTION_KEYS].sort());
});
