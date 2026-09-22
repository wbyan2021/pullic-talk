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
import { StringDecoder } from "node:string_decoder";

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
    if (run && (run.state === "running" || run.state === "stopping" || run.state === "starting")) {
      throw new PiExecutorError("busy");
    }
    const task = validateTask(rawTask);

    // 并发占位：必须在第一个 await 之前同步占用槽位。否则两个并发 start 都能通过
    // busy 检查（检查与赋值之间隔着边界解析 + 可达 10s 的 auth 子进程），后者会覆盖
    // 前者的 run 并让两个 Pi 进程同时运行。失败时恢复先前的（终态）运行记录。
    const previousRun = run;
    // 占位对象保持完整形状（subscribe/getStatus/stop 在窗口内被调用也不能炸）
    run = {
      runId: null, task: null, startedAt: null, startedAtMs: null,
      state: "starting", stopping: false, timeoutHit: false, stopRequested: false,
      output: "", truncated: false, closed: false, exitCode: null, durationMs: null,
      lastError: null, events: [], proc: null, timeoutTimer: null, killTimer: null,
    };
    let active;
    try {
      // D8：边界取活动项目
      const boundaryStatus = await projectBoundary.getStatus();
      active = boundaryStatus && boundaryStatus.active;
      if (!active) throw new PiExecutorError("no_project_selected");
      if (active.stale) throw new PiExecutorError("project_stale");

      // D7：auth 就绪检查（不读取、不传递任何凭据）
      const auth = await checkAuth();
      if (!auth.ready) {
        throw new PiExecutorError(auth.code ?? "pi_not_authenticated", { retryable: auth.retryable === true });
      }
    } catch (error) {
      run = previousRun;
      throw error;
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
      stopRequested: run.stopRequested === true, // starting 窗口内的 stop 请求不丢失
      output: "",
      truncated: false,
      closed: false,
      exitCode: null,
      durationMs: null,
      lastError: null,
      events: [],
      proc: null,
      timeoutTimer: null,
      killTimer: null,
    };
    // 闭包一律捕获本次运行的独立引用：exit 之后残留的管道数据、以及极端情况下
    // 的新运行都不能再把旧输出写进新 run
    const myRun = run;

    let proc;
    try {
      proc = spawnImpl(piBinary, ["-p", task, "--no-session", "--mode", "json"], {
        cwd: active.repoRoot,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new PiExecutorError("spawn_failed", { retryable: true });
    }
    myRun.proc = proc;
    emit("start", { runId: myRun.runId, startedAt: myRun.startedAt });

    // 等待 spawn 成功；ENOENT 等错误在 start 阶段就抛出（路由尚未进入 SSE）
    try {
      await new Promise((resolve, reject) => {
        proc.once("spawn", resolve);
        proc.once("error", reject);
      });
    } catch (error) {
      const code = error && error.code === "ENOENT" ? "pi_not_found" : "spawn_failed";
      myRun.state = "error";
      myRun.lastError = { code, retryable: true };
      myRun.durationMs = 0;
      myRun.proc = null;
      emit("status", { state: "error" });
      emit("done", { state: "error", exitCode: null, truncated: false, durationMs: 0 });
      throw new PiExecutorError(code, { retryable: true });
    }

    activeProcs.add(proc);

    // starting 窗口内用户已请求停止：启动即终止，不执行任务
    if (myRun.stopRequested) {
      myRun.stopping = true;
      terminateForStop();
      return myRun.runId;
    }

    // D10：pi 文本模式会把输出全部缓存到结束才一次性吐出，无法流式；
    // 改用 --mode json（NDJSON）后逐条增量到达。只提取 assistant text_delta 的
    // delta 文本进入输出流；thinking/其他事件与非 JSON 行一律不进流。
    const decoder = new StringDecoder("utf8");
    let stdoutLineBuffer = "";
    const MAX_LINE_BUFFER_BYTES = 1024 * 1024;

    function appendOutput(text) {
      if (!myRun || myRun.closed || myRun.truncated) return;
      const remaining = outputLimit - Buffer.byteLength(myRun.output);
      if (Buffer.byteLength(text) <= remaining) {
        myRun.output += text;
        emit("chunk", { text });
      } else {
        myRun.truncated = true;
        const slice = Buffer.from(text).subarray(0, Math.max(0, remaining)).toString();
        if (slice) {
          myRun.output += slice;
          emit("chunk", { text: slice });
        }
      }
    }

    function extractDelta(line) {
      const trimmed = line.trim();
      if (!trimmed) return null;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { return null; }
      if (!parsed || parsed.type !== "message_update") return null;
      const evt = parsed.assistantMessageEvent;
      if (!evt || evt.type !== "text_delta" || typeof evt.delta !== "string") return null;
      return evt.delta;
    }

    proc.stdout.on("data", (chunk) => {
      // StringDecoder 保证多字节 UTF-8 序列跨 chunk 边界时不会产生乱码
      stdoutLineBuffer += decoder.write(chunk);
      // 无换行的异常输出不能撑爆内存：丢掉较旧的一半，残行最多导致一次 JSON 解析失败
      if (Buffer.byteLength(stdoutLineBuffer) > MAX_LINE_BUFFER_BYTES) {
        stdoutLineBuffer = stdoutLineBuffer.slice(Math.floor(stdoutLineBuffer.length / 2));
      }
      let idx;
      while ((idx = stdoutLineBuffer.indexOf("\n")) !== -1) {
        const line = stdoutLineBuffer.slice(0, idx);
        stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
        const delta = extractDelta(line);
        if (delta) appendOutput(delta);
      }
    });

    // stderr 仅内部留存（用于诊断），绝不进入事件流或错误文案
    let stderrBuffer = "";
    proc.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      if (stderrBuffer.length > STDERR_CAP) stderrBuffer = stderrBuffer.slice(0, STDERR_CAP);
    });

    myRun.timeoutTimer = setTimeout(() => {
      if (run !== myRun || !myRun || myRun.state !== "running") return;
      myRun.timeoutHit = true;
      myRun.lastError = { code: "timeout", retryable: true };
      terminate();
    }, timeoutMs);

    proc.on("exit", (code) => {
      // 用 exit 而非 close：孙进程持有管道时 close 会延迟；exit 在进程终止时立即触发
      clearTimeout(myRun.timeoutTimer);
      clearTimeout(myRun.killTimer);
      activeProcs.delete(proc);
      myRun.closed = true; // 此后残留管道数据不再进入输出流
      if (myRun.state !== "running" && myRun.state !== "stopping") return;
      if (myRun.stopping) myRun.state = "stopped";
      else if (myRun.timeoutHit) myRun.state = "error";
      else if (code === 0) myRun.state = "exited";
      else myRun.state = "error";
      myRun.exitCode = code;
      myRun.durationMs = now() - myRun.startedAtMs;
      myRun.proc = null;
      emit("status", { state: myRun.state });
      emit("done", {
        state: myRun.state,
        exitCode: code,
        truncated: myRun.truncated,
        durationMs: myRun.durationMs,
      });
    });

    return myRun.runId;
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
    if (!run) return getStatus();
    // starting 窗口（边界/auth 检查中）还没有进程可杀：记下请求，启动后立刻终止
    if (run.state === "starting") {
      run.stopRequested = true;
      return getStatus();
    }
    if (run.state !== "running") return getStatus();
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
