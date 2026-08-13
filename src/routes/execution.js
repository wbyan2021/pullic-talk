"use strict";
// ─────────────────────────────────────────────────────────────
// Execution Routes · S03 Pi 受控运行认证 HTTP/SSE 契约
// 设计: docs/plans/2026-08-06-s03-pi-controlled-run-design.md §7–§8
//
// 约定（与护航/项目路由同构）:
// - 挂载在既有 authGate 之后，全部需要本机 Token；
// - 成功 { ok: true, execution }；失败 { ok: false, code, message, action, retryable }；
// - 固定中文文案，不透传任务原文、stderr 或内部错误文本；
// - start 成功时以 SSE 流式回放/直播执行事件；客户端断开只取消订阅，不停止 Pi。
// ─────────────────────────────────────────────────────────────
import { PiExecutorError } from "../services/pi-executor.js";

// code → [message, action, retryable]
const ERROR_INFO = {
  invalid_task: ["任务内容为空或过长。", "输入一条 4000 字以内的明确任务", false],
  no_project_selected: ["尚未设置活动项目。", "先在项目列表中设置活动项目", false],
  project_stale: ["活动项目路径已失效（目录不存在或不再是 Git 仓库）。", "移除该项目或重新设置活动项目", false],
  pi_not_found: ["找不到本机 pi 命令。", "安装 Pi CLI 后重试", false],
  pi_not_authenticated: ["Pi 认证未就绪。", "在终端运行 pi auth 配置认证，或检查 PI_AUTH_PROVIDER 设置", false],
  busy: ["已有一个 Pi 任务正在运行。", "先停止当前运行再启动新任务", false],
  spawn_failed: ["Pi 启动失败。", "检查 Pi 安装后重试", true],
  timeout: ["Pi 运行超时。", "检查任务复杂度或停止后重试", true],
  internal_error: ["执行服务暂时不可用，请重新加载后重试。", "重新加载页面", true],
};

const SAFE_HTTP_STATUS = {
  invalid_task: 400,
  no_project_selected: 400,
  project_stale: 409,
  pi_not_found: 424,
  pi_not_authenticated: 424,
  busy: 409,
  spawn_failed: 502,
  timeout: 504,
};

const UNKNOWN_ERROR = {
  ok: false,
  code: "internal_error",
  message: ERROR_INFO.internal_error[0],
  action: ERROR_INFO.internal_error[1],
  retryable: ERROR_INFO.internal_error[2],
};

const EXECUTION_FIELDS = [
  "state", "runId", "startedAt", "exitCode",
  "truncated", "durationMs", "output", "task",
];

function pick(source, fields) {
  const clean = {};
  for (const key of fields) {
    if (source && key in source) clean[key] = source[key];
  }
  return clean;
}

function safeLastError(lastError) {
  if (!lastError || typeof lastError !== "object") return null;
  return pick(lastError, ["code", "retryable"]);
}

function safeExecution(payload) {
  const clean = pick(payload, EXECUTION_FIELDS);
  clean.lastError = safeLastError(payload?.lastError);
  return clean;
}

function sendError(res, error) {
  if (!(error instanceof PiExecutorError) || !SAFE_HTTP_STATUS[error.code]) {
    return res.status(500).json(UNKNOWN_ERROR);
  }
  const [message, action, retryable] = ERROR_INFO[error.code] ?? ERROR_INFO.internal_error;
  return res.status(SAFE_HTTP_STATUS[error.code]).json({
    ok: false,
    code: error.code,
    message,
    action,
    retryable,
  });
}

export default function executionRoutes(app, { piExecutor }) {
  if (!piExecutor) throw new TypeError("piExecutor is required");

  app.get("/api/project/execution/status", async (_req, res) => {
    try {
      const status = await piExecutor.getStatus();
      res.json({ ok: true, execution: safeExecution(status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/project/execution/start", async (req, res) => {
    if (typeof req.body?.task !== "string" || req.body.task.trim().length === 0) {
      const [message, action, retryable] = ERROR_INFO.invalid_task;
      return res.status(400).json({ ok: false, code: "invalid_task", message, action, retryable });
    }
    try {
      await piExecutor.start(req.body.task);
    } catch (error) {
      return sendError(res, error);
    }
    // start 成功后进入 SSE：回放缓冲 + 直播后续事件
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const unsubscribe = piExecutor.subscribe((type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    // 客户端断开只取消订阅，不停止 Pi（进程归属服务，继续运行直至自然结束或手动停止）
    res.on("close", () => {
      try { unsubscribe(); } catch { /* 已取消 */ }
    });
  });

  app.post("/api/project/execution/stop", async (_req, res) => {
    try {
      const status = await piExecutor.stop();
      res.json({ ok: true, execution: safeExecution(status) });
    } catch (error) {
      sendError(res, error);
    }
  });
}
