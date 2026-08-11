"use strict";
// ─────────────────────────────────────────────────────────────
// Git Inspector · S02 只读 Git 适配层
// 设计: docs/plans/2026-08-06-s02-git-safety-boundary-design.md §6
//
// 安全约束:
// - 只允许 READ_ONLY_VERBS 白名单内的 git 子命令（运行期断言）；
// - spawn + 绝对路径 + 无 shell + 参数数组；目标路径只进 cwd；
// - 单命令超时回收；status 输出按字节与条目上限截断；
// - 错误只携带稳定 code，不透传 git 原始输出或路径。
// ─────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const READ_ONLY_VERBS = Object.freeze([
  "rev-parse",
  "symbolic-ref",
  "log",
  "status",
  "remote",
]);

const ALLOWED_GIT_VERBS = new Set(READ_ONLY_VERBS);

export class GitInspectorError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "GitInspectorError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function assertReadOnlyGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || typeof args[0] !== "string") {
    throw new GitInspectorError("git_failed", { retryable: true });
  }
  if (!ALLOWED_GIT_VERBS.has(args[0])) {
    throw new GitInspectorError("git_failed", { retryable: true });
  }
}

const MAX_PATH_LENGTH = 1024;

export function createGitInspector({
  gitBinary = "/usr/bin/git",
  timeoutMs = 10_000,
  statusBytesLimit = 512 * 1024,
  entryLimit = 200,
  subjectLimit = 200,
  now = () => Date.now(),
  spawnImpl = spawn,
} = {}) {
  async function runGit(args, cwd, { allowFail = false, byteLimit = null } = {}) {
    assertReadOnlyGitArgs(args);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let limitHit = false;
      let settled = false;

      const child = spawnImpl(gitBinary, args, {
        cwd,
        shell: false,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        reject(new GitInspectorError("git_timeout", { retryable: true }));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        if (limitHit) return;
        stdout += chunk.toString("utf8");
        if (byteLimit !== null && stdout.length > byteLimit) {
          limitHit = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      });
      // stderr 只消费不保存，避免原始错误文本进入任何上层载体
      child.stderr.on("data", () => {});

      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error && error.code === "ENOENT") {
          reject(new GitInspectorError("git_unavailable"));
        } else {
          reject(new GitInspectorError("git_failed", { retryable: true }));
        }
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (limitHit) {
          resolve({ stdout, exitCode: code, limitHit: true });
          return;
        }
        if (code === 0) {
          resolve({ stdout, exitCode: 0, limitHit: false });
          return;
        }
        if (allowFail) {
          resolve({ stdout, exitCode: code ?? 1, limitHit: false });
          return;
        }
        reject(new GitInspectorError("git_failed", { retryable: true }));
      });
    });
  }

  async function resolveTarget(inputPath) {
    if (
      typeof inputPath !== "string" ||
      inputPath.trim().length === 0 ||
      inputPath.trim().length > MAX_PATH_LENGTH ||
      inputPath.includes("\u0000")
    ) {
      throw new GitInspectorError("invalid_path");
    }
    const trimmed = inputPath.trim();

    let resolvedPath;
    try {
      resolvedPath = await realpath(trimmed);
    } catch {
      throw new GitInspectorError("path_not_found");
    }

    let stats;
    try {
      stats = await stat(resolvedPath);
    } catch {
      throw new GitInspectorError("path_not_found");
    }
    if (!stats.isDirectory()) {
      throw new GitInspectorError("not_a_directory");
    }

    const rootReal = await realpath("/").catch(() => "/");
    const homeReal = await realpath(homedir()).catch(() => homedir());
    if (resolvedPath === rootReal || resolvedPath === homeReal) {
      throw new GitInspectorError("forbidden_root");
    }

    return { inputPath: trimmed, resolvedPath };
  }

  function parseStatus(raw) {
    const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
    const entries = [];
    let truncated = false;

    for (const line of raw.split("\n")) {
      if (line.length < 4) continue; // 最短: "XY P"
      const xy = line.slice(0, 2);
      const file = line.slice(3);
      if (!file) continue;

      if (xy === "??") {
        counts.untracked += 1;
      } else if (xy.includes("U") || xy === "AA" || xy === "DD") {
        counts.conflicted += 1;
      } else {
        if (xy[0] !== " ") counts.staged += 1;
        if (xy[1] !== " ") counts.unstaged += 1;
      }

      if (entries.length < entryLimit) {
        entries.push({ status: xy, path: file });
      } else {
        truncated = true;
      }
    }
    return { counts, entries, truncated };
  }

  async function inspect(inputPath) {
    const { resolvedPath } = await resolveTarget(inputPath);

    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], resolvedPath, { allowFail: true });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new GitInspectorError("not_a_git_repo");
    }

    const top = await runGit(["rev-parse", "--show-toplevel"], resolvedPath);
    const repoRoot = top.stdout.trim();

    const sym = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], resolvedPath, { allowFail: true });
    const branch = sym.exitCode === 0 && sym.stdout.trim() ? sym.stdout.trim() : null;

    const head = await runGit(["rev-parse", "--verify", "--short", "HEAD"], resolvedPath, { allowFail: true });
    const hasCommits = head.exitCode === 0 && head.stdout.trim().length > 0;
    const detached = sym.exitCode !== 0 && hasCommits;

    let headCommit = null;
    if (hasCommits) {
      const log = await runGit(["log", "-1", "--format=%h%x09%cs%x09%s"], resolvedPath);
      const line = log.stdout.split("\n")[0] ?? "";
      const [hash, date, ...rest] = line.split("\t");
      if (hash && date) {
        const subject = rest.join("\t").slice(0, subjectLimit);
        headCommit = { hash, date, subject };
      }
    }

    const statusResult = await runGit(["status", "--porcelain=v1"], resolvedPath, {
      byteLimit: statusBytesLimit,
    });
    const parsed = parseStatus(statusResult.stdout);
    const truncated = parsed.truncated || statusResult.limitHit;

    const remotesResult = await runGit(["remote"], resolvedPath);
    const remotes = remotesResult.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      inputPath,
      resolvedPath,
      repoRoot,
      branch,
      detached,
      hasCommits,
      headCommit,
      counts: parsed.counts,
      entries: parsed.entries,
      truncated,
      remotes,
      inspectedAt: new Date(now()).toISOString(),
    };
  }

  return { resolveTarget, inspect };
}
