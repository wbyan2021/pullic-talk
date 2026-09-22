"use strict";

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { REDACTION_MARKER, redactText } from "./safe-redactor.js";

const MAX_EXECUTABLE_LENGTH = 256;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 1024;
const KILL_GRACE_MS = 1500;

export class ValidationRunnerError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "ValidationRunnerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function hasUnsafeSyntax(value) {
  return (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    /[;&|<>`\n\r]/.test(value) ||
    value.includes("$(") ||
    /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(value)
  );
}

function validateCommand({ executable, args }) {
  if (typeof executable !== "string" || executable.trim().length === 0 || executable.length > MAX_EXECUTABLE_LENGTH) {
    throw new ValidationRunnerError("invalid_command");
  }
  if (hasUnsafeSyntax(executable) || /\s/.test(executable.trim())) {
    throw new ValidationRunnerError("unsafe_command");
  }
  if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || hasUnsafeSyntax(arg))) {
    throw new ValidationRunnerError("unsafe_command");
  }
}

function safeExcerpt(value, maxBytes) {
  const result = redactText(value, { maxBytes });
  return {
    text: result.withheld ? REDACTION_MARKER : result.text,
    withheld: result.withheld,
    truncated: result.truncated || (result.withheld && Buffer.byteLength(REDACTION_MARKER) > maxBytes),
  };
}

export function createValidationRunner({
  projectBoundary,
  spawnImpl = spawn,
  now = () => Date.now(),
  timeoutMs = 120_000,
  outputLimit = 64 * 1024,
} = {}) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 120_000;
  const boundedOutput = Number.isFinite(outputLimit) && outputLimit > 0 ? Math.floor(outputLimit) : 64 * 1024;
  let current = null;
  let starting = false;

  async function activeProject() {
    let status;
    try {
      status = await projectBoundary.getStatus();
    } catch {
      throw new ValidationRunnerError("internal_error", { retryable: true });
    }
    const active = status?.active;
    if (!active) throw new ValidationRunnerError("no_project_selected");
    if (active.stale || typeof active.repoRoot !== "string") throw new ValidationRunnerError("project_stale");
    return active;
  }

  async function resolveCwd(cwd, repoRoot) {
    if (cwd === undefined || cwd === null || cwd === ".") return repoRoot;
    if (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.includes("\u0000")) {
      throw new ValidationRunnerError("cwd_not_active_project");
    }
    try {
      const requestedPath = path.resolve(cwd);
      const activePath = path.resolve(repoRoot);
      const resolveExisting = async (value) => {
        try { return await realpath(value); } catch { return null; }
      };
      const [resolved, activeRoot] = await Promise.all([resolveExisting(requestedPath), resolveExisting(activePath)]);
      if (resolved && activeRoot) {
        if (resolved !== activeRoot) throw new ValidationRunnerError("cwd_not_active_project");
        return resolved;
      }
      if (requestedPath !== activePath) throw new ValidationRunnerError("cwd_not_active_project");
      return requestedPath;
    } catch (error) {
      if (error instanceof ValidationRunnerError) throw error;
      throw new ValidationRunnerError("cwd_not_active_project");
    }
  }

  async function run(input = {}) {
    // 并发占位：busy 检查与 current 赋值之间隔着项目解析，必须用同步标志位封住窗口，
    // 否则并发调用会重复执行用户批准的命令
    if (current || starting) throw new ValidationRunnerError("busy");
    if (input.approvedByUser !== true) throw new ValidationRunnerError("approval_required");
    validateCommand(input);
    starting = true;
    try {
      return await runClaimed(input);
    } finally {
      starting = false;
    }
  }

  async function runClaimed(input) {
    const active = await activeProject();
    const cwd = await resolveCwd(input.cwd, active.repoRoot);
    const startedAtMs = now();
    const task = { proc: null, stopping: false, timedOut: false, settled: false };
    current = task;

    let stdout = "";
    let withheld = false;
    let truncated = false;
    const appendOutput = (chunk) => {
      if (task.settled || truncated) return;
      const excerpt = safeExcerpt(chunk.toString("utf8"), boundedOutput);
      withheld ||= excerpt.withheld;
      truncated ||= excerpt.truncated;
      const remaining = boundedOutput - Buffer.byteLength(stdout, "utf8");
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      let text = excerpt.text;
      if (Buffer.byteLength(text, "utf8") > remaining) {
        text = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
        while (text && Buffer.byteLength(text, "utf8") > remaining) text = text.slice(0, -1);
        truncated = true;
      }
      stdout += text;
    };

    const result = await new Promise((resolve) => {
      let timer;
      const finish = (exitCode, signal, code = null) => {
        if (task.settled) return;
        task.settled = true;
        clearTimeout(timer);
        clearTimeout(task.killTimer);
        const finishedAtMs = now();
        const finalExcerpt = safeExcerpt(stdout, boundedOutput);
        withheld ||= finalExcerpt.withheld;
        truncated ||= finalExcerpt.truncated;
        const state = task.stopping ? "stopped" : (task.timedOut ? "failed" : (exitCode === 0 ? "passed" : "failed"));
        resolve({
          executable: input.executable,
          args: [...input.args],
          cwd,
          approvedByUser: true,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(finishedAtMs).toISOString(),
          exitCode: Number.isInteger(exitCode) ? exitCode : null,
          signal: typeof signal === "string" ? signal : null,
          result: state,
          code: code ?? (task.timedOut ? "timeout" : null),
          durationMs: Math.max(0, finishedAtMs - startedAtMs),
          output: finalExcerpt.text,
          withheld,
          truncated,
        });
      };
      try {
        task.proc = spawnImpl(input.executable, [...input.args], {
          cwd,
          shell: false,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        return finish(null, null, "spawn_failed");
      }
      if (!task.proc || !task.proc.stdout || !task.proc.stderr) return finish(null, null, "spawn_failed");
      task.proc.stdout.on("data", appendOutput);
      // stderr is consumed but never retained or returned.
      task.proc.stderr.on("data", () => {});
      task.proc.on("error", () => finish(null, null, "spawn_failed"));
      task.proc.on("close", (exitCode, signal) => finish(exitCode, signal));
      timer = setTimeout(() => {
        if (task.settled) return;
        task.timedOut = true;
        try { task.proc.kill("SIGTERM"); } catch { /* already exited */ }
        // 忽略 SIGTERM 的命令必须有 SIGKILL 兜底，否则 runner 永久卡 busy
        task.killTimer = setTimeout(() => {
          try { if (!task.settled) task.proc.kill("SIGKILL"); } catch { /* already exited */ }
        }, KILL_GRACE_MS);
      }, boundedTimeout);
    });
    current = null;
    return result;
  }

  async function stop() {
    if (!current) return { state: "idle" };
    current.stopping = true;
    try { current.proc?.kill("SIGTERM"); } catch { /* already exited */ }
    clearTimeout(current.killTimer);
    current.killTimer = setTimeout(() => {
      try { if (!current.settled) current.proc?.kill("SIGKILL"); } catch { /* already exited */ }
    }, KILL_GRACE_MS);
    return { state: "stopping" };
  }

  return { run, stop };
}
