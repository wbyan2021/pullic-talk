import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createGitInspector,
  GitInspectorError,
  READ_ONLY_VERBS,
  assertReadOnlyGitArgs,
} from "../src/services/git-inspector.js";

// ── fixture helpers（只在 os.tmpdir() 内创建，绝不触碰真实仓库） ──

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

function gitAllowFail(cwd, ...args) {
  return spawnSync("git", [...GIT_OPTS, ...args], { cwd, encoding: "utf8" });
}

function makeTmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "s02-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRepo(t, { commits = 1 } = {}) {
  const dir = makeTmpDir(t);
  git(dir, "init", "-q");
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `v${i}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `commit ${i}`);
  }
  return dir;
}

function makeSleepBinary(t) {
  const dir = makeTmpDir(t);
  const bin = join(dir, "slow-git");
  writeFileSync(bin, "#!/bin/sh\nsleep 5\n");
  chmodSync(bin, 0o755);
  return bin;
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitInspectorError, `expected GitInspectorError, got ${error?.constructor?.name}: ${error?.message}`);
    return error.code;
  }
  assert.fail("expected rejection");
}

// ── 只读动词白名单 ──

test("READ_ONLY_VERBS contains exactly the approved read-only commands", () => {
  assert.deepEqual([...READ_ONLY_VERBS].sort(), ["log", "remote", "rev-parse", "status", "symbolic-ref"]);
});

test("assertReadOnlyGitArgs rejects any write verb", () => {
  for (const verb of ["checkout", "commit", "stash", "push", "reset", "clean", "add", "rm", "branch", "merge", "rebase", "init", "clone"]) {
    assert.throws(() => assertReadOnlyGitArgs([verb, "--help"]), GitInspectorError);
  }
  assert.doesNotThrow(() => assertReadOnlyGitArgs(["status", "--porcelain=v1"]));
});

// ── 识别：干净与脏仓库 ──

test("inspects a clean repo with branch, head commit and zero counts", async (t) => {
  const repo = makeRepo(t);
  const inspector = createGitInspector();
  const info = await inspector.inspect(repo);
  assert.equal(info.branch, "main");
  assert.equal(info.detached, false);
  assert.equal(info.hasCommits, true);
  assert.deepEqual(info.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
  assert.deepEqual(info.entries, []);
  assert.equal(info.truncated, false);
  assert.deepEqual(info.remotes, []);
  assert.ok(info.headCommit.hash.length >= 7);
  assert.ok(info.headCommit.subject.includes("commit 1"));
  assert.match(info.headCommit.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(info.repoRoot.length > 0);
  assert.ok(info.inspectedAt);
});

test("counts staged, unstaged and untracked changes separately", async (t) => {
  const repo = makeRepo(t);
  // staged: 新文件加入索引
  writeFileSync(join(repo, "staged.txt"), "s\n");
  git(repo, "add", "staged.txt");
  // unstaged: 修改已跟踪文件
  writeFileSync(join(repo, "file-1.txt"), "modified\n");
  // untracked: 未跟踪文件
  writeFileSync(join(repo, "untracked.txt"), "u\n");

  const info = await createGitInspector().inspect(repo);
  assert.equal(info.counts.staged, 1);
  assert.equal(info.counts.unstaged, 1);
  assert.equal(info.counts.untracked, 1);
  assert.equal(info.counts.conflicted, 0);
  const byPath = Object.fromEntries(info.entries.map((e) => [e.path, e.status]));
  assert.equal(byPath["staged.txt"], "A ");
  assert.equal(byPath["file-1.txt"], " M");
  assert.equal(byPath["untracked.txt"], "??");
});

test("detects conflicted entries from a failed merge", async (t) => {
  const repo = makeRepo(t);
  git(repo, "checkout", "-q", "-b", "other");
  writeFileSync(join(repo, "file-1.txt"), "other side\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "other change");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "file-1.txt"), "main side\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "main change");
  const merge = gitAllowFail(repo, "merge", "-q", "other");
  assert.notEqual(merge.status, 0, "merge fixture must conflict");

  const info = await createGitInspector().inspect(repo);
  assert.equal(info.counts.conflicted, 1);
  assert.ok(info.entries.some((e) => e.path === "file-1.txt" && e.status === "UU"));
});

// ── 识别：detached / unborn / remotes ──

test("reports detached HEAD", async (t) => {
  const repo = makeRepo(t);
  git(repo, "checkout", "-q", "--detach");
  const info = await createGitInspector().inspect(repo);
  assert.equal(info.detached, true);
  assert.equal(info.branch, null);
  assert.equal(info.hasCommits, true);
});

test("reports unborn repo without commits", async (t) => {
  const dir = makeTmpDir(t);
  git(dir, "init", "-q");
  const info = await createGitInspector().inspect(dir);
  assert.equal(info.hasCommits, false);
  assert.equal(info.detached, false);
  assert.equal(info.branch, "main");
  assert.equal(info.headCommit, null);
  assert.deepEqual(info.counts, { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test("lists remotes", async (t) => {
  const repo = makeRepo(t);
  git(repo, "remote", "add", "origin", "https://example.invalid/x.git");
  const info = await createGitInspector().inspect(repo);
  assert.deepEqual(info.remotes, ["origin"]);
});

// ── 错误分类 ──

test("non-repo directory rejects not_a_git_repo", async (t) => {
  const dir = makeTmpDir(t);
  const code = await rejectCode(createGitInspector().inspect(dir));
  assert.equal(code, "not_a_git_repo");
});

test("missing git binary rejects git_unavailable", async (t) => {
  const repo = makeRepo(t);
  const inspector = createGitInspector({ gitBinary: "/nonexistent/git-xyz" });
  const code = await rejectCode(inspector.inspect(repo));
  assert.equal(code, "git_unavailable");
});

test("slow git rejects git_timeout", async (t) => {
  const repo = makeRepo(t);
  const inspector = createGitInspector({ gitBinary: makeSleepBinary(t), timeoutMs: 200 });
  const code = await rejectCode(inspector.inspect(repo));
  assert.equal(code, "git_timeout");
});

// ── 输出边界 ──

test("caps entries at entryLimit and marks truncated", async (t) => {
  const repo = makeRepo(t);
  for (let i = 0; i < 4; i++) writeFileSync(join(repo, `u-${i}.txt`), "x\n");
  const info = await createGitInspector({ entryLimit: 2 }).inspect(repo);
  assert.equal(info.entries.length, 2);
  assert.equal(info.truncated, true);
  assert.equal(info.counts.untracked, 4, "counts must reflect full status output, not the capped entry list");
});

test("caps status bytes and marks truncated", async (t) => {
  const repo = makeRepo(t);
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, `u-${String(i).padStart(2, "0")}.txt`), "x\n");
  const info = await createGitInspector({ statusBytesLimit: 120 }).inspect(repo);
  assert.equal(info.truncated, true);
  assert.ok(info.counts.untracked >= 1);
});

// ── 路径安全 ──

test("path validation rejects invalid inputs", async (t) => {
  const inspector = createGitInspector();
  assert.equal(await rejectCode(inspector.inspect("")), "invalid_path");
  assert.equal(await rejectCode(inspector.inspect("   ")), "invalid_path");
  assert.equal(await rejectCode(inspector.inspect("x".repeat(2000))), "invalid_path");
  assert.equal(await rejectCode(inspector.inspect("bad\u0000path")), "invalid_path");
});

test("nonexistent path rejects path_not_found", async (t) => {
  const dir = makeTmpDir(t);
  const code = await rejectCode(createGitInspector().inspect(join(dir, "no-such-dir")));
  assert.equal(code, "path_not_found");
});

test("file path rejects not_a_directory", async (t) => {
  const repo = makeRepo(t);
  const code = await rejectCode(createGitInspector().inspect(join(repo, "file-1.txt")));
  assert.equal(code, "not_a_directory");
});

test("home root rejects forbidden_root", async (t) => {
  const code = await rejectCode(createGitInspector().inspect(homedir()));
  assert.equal(code, "forbidden_root");
});

test("resolves symlinked repo to its real path", async (t) => {
  const repo = makeRepo(t);
  const parent = makeTmpDir(t);
  const link = join(parent, "link-to-repo");
  symlinkSync(repo, link);
  const { realpathSync } = await import("node:fs");
  const info = await createGitInspector().inspect(link);
  assert.equal(info.resolvedPath, realpathSync(repo));
  assert.notEqual(info.resolvedPath, link);
  assert.equal(info.inputPath, link);
});

// ── 错误语义 ──

test("GitInspectorError carries code and retryable without raw git output", async (t) => {
  const dir = makeTmpDir(t);
  try {
    await createGitInspector().inspect(dir);
    assert.fail("expected rejection");
  } catch (error) {
    assert.equal(error.code, "not_a_git_repo");
    assert.equal(typeof error.retryable, "boolean");
    assert.ok(!error.message.includes(dir), "error message must not leak paths or raw output");
  }
});
