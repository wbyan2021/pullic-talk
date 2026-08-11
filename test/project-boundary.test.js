import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { createGitInspector } from "../src/services/git-inspector.js";
import {
  createProjectBoundary,
  ProjectBoundaryError,
} from "../src/services/project-boundary.js";

// ── fixture helpers（只在 os.tmpdir() 内创建） ──

const GIT_OPTS = [
  "-c", "user.name=s02-test",
  "-c", "user.email=s02@test.local",
  "-c", "init.defaultBranch=main",
];

function git(cwd, ...args) {
  const r = spawnSync("git", [...GIT_OPTS, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeTmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "s02-boundary-"));
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

const PAYLOAD_KEYS = ["selected", "inputPath", "resolvedPath", "repoRoot", "selectedAt", "stale", "inspection", "selectionSnapshotAt"];
const INSPECTION_KEYS = ["inspectedAt", "branch", "detached", "hasCommits", "headCommit", "counts", "entries", "truncated", "remotes"];

// ── 状态机 ──

test("getStatus before any selection reports not selected", async (t) => {
  const { service } = makeBoundary(t);
  assert.deepEqual(await service.getStatus(), { selected: false });
});

test("select persists the project and returns the full payload", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repo = makeRepo(t);

  const payload = await service.select(repo);
  assert.equal(payload.selected, true);
  assert.equal(payload.inputPath, repo);
  assert.equal(payload.stale, false);
  assert.equal(payload.inspection.branch, "main");
  assert.ok(payload.selectedAt);
  assert.ok(payload.selectionSnapshotAt);
  assert.ok(!("selectionSnapshot" in payload), "raw snapshot must stay server-side");

  assert.ok(existsSync(statePath));
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.project.repoRoot, payload.repoRoot);
  assert.ok(stored.project.selectionSnapshot, "selection snapshot must be persisted for S05");
});

test("selecting a second project replaces the first entirely", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repoA = makeRepo(t);
  const repoB = makeRepo(t);

  await service.select(repoA);
  const payload = await service.select(repoB);
  assert.equal(payload.repoRoot !== repoA, true);
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.project.inputPath, repoB);
});

test("select failures pass through inspector codes and write nothing", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const plainDir = makeTmpDir(t);

  assert.equal(await rejectCode(service.select(plainDir)), "not_a_git_repo");
  assert.equal(await rejectCode(service.select(join(plainDir, "missing"))), "path_not_found");
  assert.ok(!existsSync(statePath), "no state file may be written on failed select");
  assert.deepEqual(await service.getStatus(), { selected: false });
});

test("refresh without selection rejects no_project_selected", async (t) => {
  const { service } = makeBoundary(t);
  assert.equal(await rejectCode(service.refresh()), "no_project_selected");
});

test("refresh updates inspection but keeps selectedAt", async (t) => {
  const { service, statePath, advance } = makeBoundary(t);
  const repo = makeRepo(t);
  const first = await service.select(repo);

  advance(60_000);
  const second = await service.refresh();
  assert.equal(second.selectedAt, first.selectedAt);
  assert.notEqual(second.inspection.inspectedAt, first.inspection.inspectedAt);

  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(stored.project.selectedAt, first.selectedAt);
});

test("deleted project becomes stale; refresh rejects project_stale; clear still works", async (t) => {
  const { service } = makeBoundary(t);
  const repo = makeRepo(t);
  await service.select(repo);

  rmSync(repo, { recursive: true, force: true });

  const status = await service.getStatus();
  assert.equal(status.selected, true);
  assert.equal(status.stale, true);

  assert.equal(await rejectCode(service.refresh()), "project_stale");

  assert.deepEqual(await service.clear(), { selected: false });
});

test("clear is idempotent", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repo = makeRepo(t);
  await service.select(repo);

  assert.deepEqual(await service.clear(), { selected: false });
  assert.ok(!existsSync(statePath));
  assert.deepEqual(await service.clear(), { selected: false });
});

test("corrupted state file degrades to no selection without throwing", async (t) => {
  const { service, statePath } = makeBoundary(t);
  writeFileSync(statePath, "{ this is not json");
  assert.deepEqual(await service.getStatus(), { selected: false });
});

test("selection survives service restart via state file", async (t) => {
  const { service, statePath } = makeBoundary(t);
  const repo = makeRepo(t);
  const original = await service.select(repo);

  const second = createProjectBoundary({
    inspector: createGitInspector(),
    statePath,
  });
  const status = await second.getStatus();
  assert.equal(status.selected, true);
  assert.equal(status.repoRoot, original.repoRoot);
  assert.equal(status.selectedAt, original.selectedAt);
});

// ── 输出白名单 ──

test("payload exposes only whitelisted keys", async (t) => {
  const { service } = makeBoundary(t);
  const repo = makeRepo(t);
  const payload = await service.select(repo);
  assert.deepEqual(Object.keys(payload).sort(), [...PAYLOAD_KEYS].sort());
  assert.deepEqual(Object.keys(payload.inspection).sort(), [...INSPECTION_KEYS].sort());
});
