"use strict";
// ─────────────────────────────────────────────────────────────
// Pi Executor Service · S03 受控执行适配层
// 设计: docs/plans/2026-08-06-s03-pi-controlled-run-design.md §6（含 D7/D8 修订）
//
// 约束:
// - 唯一接触 Pi 子进程的地方；无 shell、参数数组、cwd = 活动项目 repoRoot；
// - 不传 --api-key、不读取或传递任何凭据（D1）；
// - auth 检查 `pi auth check --provider <P> --json`，P = authProvider 选项
//   > env PI_AUTH_PROVIDER > env PI_PROVIDER > "google"（D7，0.84.1 要求带 provider）；
// - 边界来自 ProjectBoundary v2 的活动（ACTIVE）项目（D8）；
// - 单运行实例、SIGTERM 停止、超时回收、输出截断、stderr 不外泄；
// - 运行进程注册进 activeProcs，服务关闭时被统一清理。
// ─────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";

import { activeProcs } from "../utils/process-registry.js";

const TASK_MAX_LENGTH = 4000;
const STDERR_CAP = 64 * 1024;

export class PiExecutorError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "PiExecutorError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function createPiExecutor({
  projectBoundary,
  piBinary = "pi",
  authProvider = undefined,
  timeoutMs = 600_000,
  outputLimit = 512 * 1024,
  killGraceMs = 3_000,
  authTimeoutMs = 10_000,
  now = () => Date.now(),
  spawnImpl = spawn,
} = {}) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");

  let run = null; // 保留最近一次 run 供状态查询与 SSE 回放
  let seq = 0;
  const listeners = new Set();

  function resolveProvider() {
    return authProvider ?? process.env.PI_AUTH_PROVIDER ?? process.env.PI_PROVIDER ?? "google";
  }

  function emit(type, data) {
    if (run) run.events.push({ type, data });
    for (const listener of [...listeners]) {
      try {
        listener(type, data);
      } catch {
        /* 订阅者错误不影响执行器 */
      }
    }
  }

  function subscribe(listener) {
    if (run) for (const event of run.events) {
      try { listener(event.type, event.data); } catch { /* 同上 */ }
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function validateTask(rawTask) {
    if (typeof rawTask !== "string") throw new PiExecutorError("invalid_task");
    const task = rawTask.trim();
    if (!task || task.length > TASK_MAX_LENGTH || task.includes("\u0000")) {
      throw new PiExecutorError("invalid_task");
    }
    return task;
  }

  function checkAuth() {
    const provider = resolveProvider();
    return new Promise((resolve) => {
      let settled = false;
      let stdout = "";
      let proc;
      try {
        proc = spawnImpl(piBinary, ["auth", "check", "--provider", provider, "--json"], {
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return resolve({ ready: false, code: "pi_not_found" });
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
        resolve({ ready: false, code: "pi_not_authenticated", retryable: true });
      }, authTimeoutMs);
      proc.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ready: false, code: "pi_not_found" });
      });
      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > STDERR_CAP) stdout = stdout.slice(0, STDERR_CAP);
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed && parsed.status === "ready") return resolve({ ready: true, provider });
          } catch {
            /* 非法 JSON → 未就绪 */
          }
        }
        resolve({ ready: false, code: "pi_not_authenticated" });
      });
    });
  }

  function terminateForStop() {
    run.state = "stopping";
    emit("status", { state: "stopping" });
    try { run.proc.kill("SIGTERM"); } catch { /* 已退出 */ }
    run.killTimer = setTimeout(() => {
      try {
        if (run.proc && run.exitCode === null) run.proc.kill("SIGKILL");
      } catch { /* 已退出 */ }
    }, killGraceMs);
  }

  async function start(rawTask) {
    if (run && (run.state === "running" || run.state === "stopping")) {
      throw new PiExecutorError("busy");
    }
    const task = validateTask(rawTask);

    // D8：边界取活动项目
    const boundaryStatus = await projectBoundary.getStatus();
    const active = boundaryStatus && boundaryStatus.active;
    if (!active) throw new PiExecutorError("no_project_selected");
    if (active.stale) throw new PiExecutorError("project_stale");

    // D7：auth 就绪检查（不读取、不传递任何凭据）
    const auth = await checkAuth();
    if (!auth.ready) {
      throw new PiExecutorError(auth.code ?? "pi_not_authenticated", { retryable: auth.retryable === true });
    }

    const startedAtMs = now();
    run = {
      runId: `run_${++seq}_${startedAtMs.toString(36)}`,
      task,
      startedAt: new Date(startedAtMs).toISOString(),
      startedAtMs,
      state: "running",
      stopping: false,
      timeoutHit: false,
      output: "",
      truncated: false,
      exitCode: null,
      durationMs: null,
      lastError: null,
      events: [],
      proc: null,
      timeoutTimer: null,
      killTimer: null,
    };

    let proc;
    try {
      proc = spawnImpl(piBinary, ["-p", task, "--no-session"], {
        cwd: active.repoRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new PiExecutorError("spawn_failed", { retryable: true });
    }
    run.proc = proc;
    emit("start", { runId: run.runId, startedAt: run.startedAt });

    // 等待 spawn 成功；ENOENT 等错误在 start 阶段就抛出（路由尚未进入 SSE）
    try {
      await new Promise((resolve, reject) => {
        proc.once("spawn", resolve);
        proc.once("error", reject);
      });
    } catch (error) {
      const code = error && error.code === "ENOENT" ? "pi_not_found" : "spawn_failed";
      run.state = "error";
      run.lastError = { code, retryable: true };
      run.durationMs = 0;
      run.proc = null;
      emit("status", { state: "error" });
      emit("done", { state: "error", exitCode: null, truncated: false, durationMs: 0 });
      throw new PiExecutorError(code, { retryable: true });
    }

    activeProcs.add(proc);

    proc.stdout.on("data", (chunk) => {
      if (!run || run.truncated) return;
      const text = chunk.toString();
      const remaining = outputLimit - Buffer.byteLength(run.output);
      if (Buffer.byteLength(text) <= remaining) {
        run.output += text;
        emit("chunk", { text });
      } else {
        run.truncated = true;
        const slice = Buffer.from(text).subarray(0, Math.max(0, remaining)).toString();
        if (slice) {
          run.output += slice;
          emit("chunk", { text: slice });
        }
      }
    });

    // stderr 仅内部留存（用于诊断），绝不进入事件流或错误文案
    let stderrBuffer = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > STDERR_CAP) stderrBuffer = stderrBuffer.slice(0, STDERR_CAP);
    });

    run.timeoutTimer = setTimeout(() => {
      if (!run || run.state !== "running") return;
      run.timeoutHit = true;
      run.lastError = { code: "timeout", retryable: true };
      terminate();
    }, timeoutMs);

    proc.on("exit", (code) => {
      // 用 exit 而非 close：孙进程持有管道时 close 会延迟；exit 在进程终止时立即触发
      clearTimeout(run.timeoutTimer);
      clearTimeout(run.killTimer);
      activeProcs.delete(proc);
      if (run.state !== "running" && run.state !== "stopping") return;
      if (run.stopping) run.state = "stopped";
      else if (run.timeoutHit) run.state = "error";
      else if (code === 0) run.state = "exited";
      else run.state = "error";
      run.exitCode = code;
      run.durationMs = now() - run.startedAtMs;
      run.proc = null;
      emit("status", { state: run.state });
      emit("done", {
        state: run.state,
        exitCode: code,
        truncated: run.truncated,
        durationMs: run.durationMs,
      });
    });

    return run.runId;
  }

  function terminate() {
    // 与 stop 共享的终止动作，但不改变 stopping 语义（超时路径用）
    try { run.proc.kill("SIGTERM"); } catch { /* 已退出 */ }
    run.killTimer = setTimeout(() => {
      try {
        if (run.proc && run.exitCode === null) run.proc.kill("SIGKILL");
      } catch { /* 已退出 */ }
    }, killGraceMs);
  }

  function stop() {
    if (!run || run.state !== "running") return getStatus();
    run.stopping = true;
    terminateForStop();
    return getStatus();
  }

  function getStatus() {
    if (!run) {
      return {
        state: "idle", runId: null, startedAt: null, exitCode: null,
        truncated: false, durationMs: null, output: "", task: null, lastError: null,
      };
    }
    return {
      state: run.state,
      runId: run.runId,
      startedAt: run.startedAt,
      exitCode: run.exitCode,
      truncated: run.truncated,
      durationMs: run.state === "running" || run.state === "stopping" ? now() - run.startedAtMs : run.durationMs,
      output: run.output,
      task: run.task,
      lastError: run.lastError,
    };
  }

  return { start, stop, checkAuth, getStatus, subscribe };
}
