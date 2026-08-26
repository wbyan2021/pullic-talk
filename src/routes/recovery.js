"use strict";

import { TaskRecoveryError } from "../services/task-recovery.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const REASON_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STATES = new Set(["not_available", "previewable", "busy", "stale", "unknown"]);
const SOURCE_STATES = new Set(["failed", "interrupted"]);

const ERROR_INFO = {
  recovery_not_eligible: ["此任务当前不可恢复。", "查看任务状态和验收结果", false],
  recovery_task_not_found: ["找不到原任务记录。", "刷新总览", false],
  recovery_payload_unavailable: ["原任务记录不完整，无法安全恢复。", "重新开始一条新任务", false],
  recovery_project_stale: ["活动项目已失效。", "重新识别或选择项目", false],
  recovery_busy: ["已有 Pi 任务正在运行。", "等待当前任务结束", false],
  recovery_preview_expired: ["恢复预览已过期或项目状态已变化。", "重新生成预览", false],
  recovery_confirmation_required: ["需要明确确认后才能恢复。", "阅读预览并确认", false],
  recovery_start_failed: ["恢复启动失败，原任务记录已保留。", "根据错误码处理后重试", true],
  recovery_internal_error: ["恢复服务暂时不可用，请重新加载后重试。", "重新加载页面", true],
};

const HTTP_STATUS = {
  recovery_not_eligible: 409,
  recovery_task_not_found: 404,
  recovery_payload_unavailable: 409,
  recovery_project_stale: 409,
  recovery_busy: 409,
  recovery_preview_expired: 409,
  recovery_confirmation_required: 409,
  recovery_start_failed: 502,
  recovery_internal_error: 500,
};

const UNKNOWN_ERROR = {
  ok: false,
  code: "recovery_internal_error",
  message: ERROR_INFO.recovery_internal_error[0],
  action: ERROR_INFO.recovery_internal_error[1],
  retryable: ERROR_INFO.recovery_internal_error[2],
};

function safeString(value, max = 256) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function safeReason(value) {
  return typeof value === "string" && REASON_PATTERN.test(value) ? value : null;
}

function safeTaskId(value) {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function safeRecoveryStatus(source) {
  const input = source && typeof source === "object" ? source : {};
  const sourceState = SOURCE_STATES.has(input.sourceState) ? input.sourceState : null;
  const state = STATES.has(input.state) ? input.state : "unknown";
  return {
    available: input.available === true,
    sourceTaskId: safeTaskId(input.sourceTaskId),
    sourceState,
    reasonCode: safeReason(input.reasonCode),
    state,
  };
}

function safePreview(source) {
  const input = source && typeof source === "object" ? source : {};
  return {
    eligible: input.eligible === true,
    sourceTaskId: safeTaskId(input.sourceTaskId),
    sourceState: SOURCE_STATES.has(input.sourceState) ? input.sourceState : null,
    reasonCode: safeReason(input.reasonCode),
    projectId: safeTaskId(input.projectId),
    branch: safeString(input.branch),
    head: safeString(input.head, 128),
    worktree: ["clean", "modified", "unknown"].includes(input.worktree) ? input.worktree : "unknown",
    changedCount: Number.isInteger(input.changedCount) && input.changedCount >= 0 ? input.changedCount : 0,
    beforeHead: safeString(input.beforeHead, 128),
    previewId: safeTaskId(input.previewId),
    expiresAt: safeString(input.expiresAt, 64),
    confirmationRequired: input.confirmationRequired === true,
    fileRollback: input.fileRollback === "not_included" ? "not_included" : "not_included",
  };
}

function safeStarted(source) {
  const input = source && typeof source === "object" ? source : {};
  return {
    sourceTaskId: safeTaskId(input.sourceTaskId),
    taskId: safeTaskId(input.taskId),
    runId: safeTaskId(input.runId),
  };
}

function sendError(res, error) {
  if (!(error instanceof TaskRecoveryError) || !ERROR_INFO[error.code]) return res.status(500).json(UNKNOWN_ERROR);
  const [message, action, defaultRetryable] = ERROR_INFO[error.code];
  return res.status(HTTP_STATUS[error.code] ?? 500).json({
    ok: false,
    code: error.code,
    message,
    action,
    retryable: error.retryable === true || defaultRetryable,
  });
}

function taskIdFrom(req) {
  return req?.params?.taskId;
}

export default function recoveryRoutes(app, { taskRecovery } = {}) {
  if (!taskRecovery) throw new TypeError("taskRecovery is required");

  app.get("/api/recovery/status", async (_req, res) => {
    try {
      const status = await taskRecovery.getStatus();
      return res.json({ ok: true, recovery: safeRecoveryStatus(status) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get("/api/recovery/:taskId/preview", async (req, res) => {
    try {
      const preview = await taskRecovery.preview({ taskId: taskIdFrom(req) });
      return res.json({ ok: true, recovery: safePreview(preview) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/recovery/:taskId/start", async (req, res) => {
    const previewId = req?.body?.previewId;
    if (typeof previewId !== "string" || !ID_PATTERN.test(previewId)) {
      return sendError(res, new TaskRecoveryError("recovery_preview_expired"));
    }
    if (req?.body?.confirmed !== true) {
      return sendError(res, new TaskRecoveryError("recovery_confirmation_required"));
    }
    try {
      const started = await taskRecovery.start({
        taskId: taskIdFrom(req),
        previewId,
        confirmed: true,
      });
      return res.json({ ok: true, recovery: safeStarted(started) });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
