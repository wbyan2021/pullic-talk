"use strict";

import { AiHandoffError } from "../services/ai-handoff.js";
import { TaskEvidenceError } from "../services/task-evidence.js";
import { ValidationRunnerError } from "../services/validation-runner.js";
import { ProjectBoundaryError } from "../services/project-boundary.js";

const ERROR_INFO = {
  invalid_command: ["验收命令必须由程序和参数组成。", "不要输入 shell 命令字符串", false],
  unsafe_command: ["验收命令包含不允许的 shell 语法。", "拆分为可审核的程序和参数", false],
  approval_required: ["执行验收命令前需要明确确认。", "确认命令、参数和项目目录后重试", false],
  busy: ["已有一条验收命令正在运行。", "等待当前命令结束", false],
  no_task: ["当前没有可验收的任务。", "先启动一条 Pi 任务", false],
  task_running: ["任务仍在运行，暂时不能收口。", "等待 Pi 结束或先停止任务", false],
  task_already_closed: ["任务已经完成收口。", "读取当前证据状态", false],
  invalid_acceptance_status: ["验收状态无效。", "使用 accepted、needs_review 或 rejected", false],
  validation_required: ["验收命令尚未通过，不能标记为 accepted。", "先确认并执行验收命令", false],
  evidence_required: ["缺少完整的 Git 前后证据。", "重新获取任务证据后再收口", false],
  user_confirmation_required: ["需要用户明确确认验收结果。", "确认当前任务结果后重试", false],
  handoff_not_enabled: ["项目尚未启用 AI 交接记录。", "先在项目面板显式启用交接记录", false],
  handoff_conflict: ["交接文件存在冲突，未覆盖原内容。", "人工处理冲突文件后重试", false],
  record_exists: ["历史交接记录已存在，系统不会覆盖。", "读取现有记录或使用新的任务标识", false],
  agents_pointer_confirmation_required: ["项目入口文件未授权写入交接指针。", "先明确授权交接入口", false],
  project_stale: ["活动项目已失效。", "重新选择活动项目", false],
  no_project_selected: ["尚未设置活动项目。", "先设置活动项目", false],
  project_not_found: ["找不到指定项目。", "刷新项目列表后重试", false],
  internal_error: ["证据服务暂时不可用。", "重新加载页面后重试", true],
};

const HTTP_STATUS = {
  invalid_command: 400,
  unsafe_command: 400,
  approval_required: 409,
  busy: 409,
  no_task: 409,
  task_running: 409,
  task_already_closed: 409,
  invalid_acceptance_status: 400,
  validation_required: 409,
  evidence_required: 409,
  user_confirmation_required: 409,
  handoff_not_enabled: 409,
  handoff_conflict: 409,
  record_exists: 409,
  agents_pointer_confirmation_required: 409,
  project_stale: 409,
  no_project_selected: 400,
  project_not_found: 404,
};

const EVIDENCE_FIELDS = [
  "taskId", "projectId", "runId", "state", "executionStatus",
  "before", "after", "gitEvidence", "validation", "evidence", "acceptanceStatus", "lastError",
];

function pick(source, fields) {
  const output = {};
  for (const field of fields) if (source && field in source) output[field] = source[field];
  return output;
}

function safeEvidence(source) {
  const clean = pick(source, EVIDENCE_FIELDS);
  if (clean.before) clean.before = pick(clean.before, ["branch", "head", "worktree", "changedPaths", "truncated"]);
  if (clean.after) clean.after = pick(clean.after, ["branch", "head", "worktree", "changedPaths", "truncated"]);
  if (clean.gitEvidence) clean.gitEvidence = pick(clean.gitEvidence, ["certainty", "reason", "causality", "newPaths", "changedPaths", "preexistingPaths"]);
  if (clean.validation) clean.validation = pick(clean.validation, ["executable", "args", "cwd", "approvedByUser", "result", "exitCode", "output", "withheld", "truncated", "code"]);
  if (clean.evidence) clean.evidence = pick(clean.evidence, ["execution", "git", "validation"]);
  if (clean.lastError) clean.lastError = pick(clean.lastError, ["code", "retryable"]);
  return clean;
}

function safeValidation(result) {
  return pick(result, ["executable", "args", "cwd", "approvedByUser", "result", "exitCode", "signal", "code", "durationMs", "output", "withheld", "truncated"]);
}

function sendError(res, error) {
  const known = error instanceof AiHandoffError || error instanceof TaskEvidenceError || error instanceof ValidationRunnerError || error instanceof ProjectBoundaryError;
  if (!known || !ERROR_INFO[error.code]) {
    const [message, action, retryable] = ERROR_INFO.internal_error;
    return res.status(500).json({ ok: false, code: "internal_error", message, action, retryable });
  }
  const [message, action, retryable] = ERROR_INFO[error.code];
  return res.status(HTTP_STATUS[error.code] ?? 500).json({ ok: false, code: error.code, message, action, retryable });
}

function parseStructuredCommand(body) {
  if (!body || body.command !== undefined || typeof body.executable !== "string" || body.executable.trim().length === 0 || !Array.isArray(body.args)) {
    throw new ValidationRunnerError("invalid_command");
  }
  return {
    executable: body.executable,
    args: body.args,
    cwd: body.cwd,
    approvedByUser: body.approvedByUser === true,
  };
}

function handoffInput(status, acceptanceStatus, nextAction) {
  return {
    repoRoot: status.repoRoot,
    taskId: status.taskId,
    taskStatus: acceptanceStatus,
    plan: status.plan ?? { source: "docs/NOW.md", revision: "unknown", completed: 0, total: 0, percent: "unknown" },
    before: status.before,
    after: status.after,
    evidence: status.evidence,
    facts: status.facts ?? { verified: [], user_confirmed: [], agent_reported: [], recorded_not_reverified: [], unknown: [] },
    issuesAndRisks: status.issuesAndRisks ?? [],
    nextAction: nextAction || status.nextAction || "重新读取 AI 交接当前状态",
    sourceRunId: status.runId,
  };
}

export default function evidenceRoutes(app, { taskEvidence, validationRunner, aiHandoff, projectBoundary } = {}) {
  if (!taskEvidence) throw new TypeError("taskEvidence is required");
  if (!validationRunner) throw new TypeError("validationRunner is required");
  if (!aiHandoff) throw new TypeError("aiHandoff is required");

  app.get("/api/evidence/status", async (_req, res) => {
    try {
      const status = await taskEvidence.getEvidenceStatus();
      return res.json({ ok: true, evidence: safeEvidence(status) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/evidence/validation/preview", async (req, res) => {
    try {
      const command = parseStructuredCommand(req.body);
      return res.json({ ok: true, validation: { ...command, approvedByUser: false, result: "not_run" } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/evidence/validation/run", async (req, res) => {
    try {
      const command = parseStructuredCommand(req.body);
      const result = await validationRunner.run(command);
      const recorded = await taskEvidence.recordValidation(result);
      return res.json({ ok: true, validation: safeValidation(recorded) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/evidence/close", async (req, res) => {
    const requested = req.body?.acceptanceStatus;
    if (!["accepted", "needs_review", "rejected"].includes(requested)) {
      return sendError(res, new TaskEvidenceError("invalid_acceptance_status"));
    }
    try {
      const status = await taskEvidence.getEvidenceStatus();
      if (status.acceptanceStatus && status.acceptanceStatus !== "pending") {
        if (status.acceptanceStatus === requested) return res.json({ ok: true, idempotent: true, evidence: safeEvidence(status) });
        throw new TaskEvidenceError("task_already_closed");
      }
      if (!status.taskId) throw new TaskEvidenceError("no_task");
      if (requested === "accepted") {
        if (status.validation?.result !== "passed") throw new TaskEvidenceError("validation_required");
        if (status.evidence?.git !== "verified") throw new TaskEvidenceError("evidence_required");
        if (req.body?.userConfirmed !== true) throw new TaskEvidenceError("user_confirmation_required");
      }
      if (typeof projectBoundary?.getHandoff === "function") {
        const handoff = await projectBoundary.getHandoff(status.projectId);
        if (!handoff?.enabled) throw new TaskEvidenceError("handoff_not_enabled");
      }
      const input = handoffInput(status, requested, req.body?.nextAction);
      let history;
      try {
        history = await aiHandoff.writeRecord(input);
      } catch (error) {
        // 上次尝试可能已写入记录但收口失败：record_exists 时继续补写当前交接并收口，避免死锁
        if (error?.code !== "record_exists") throw error;
        history = { path: `docs/ai-ops/records/${status.taskId}.md` };
      }
      await aiHandoff.writeCurrent({ ...input, latestRecord: history.path });
      const closed = await taskEvidence.closeTask({ acceptanceStatus: requested, userConfirmed: req.body?.userConfirmed === true, handoffWritten: true });
      return res.json({ ok: true, evidence: safeEvidence(closed), handoff: { latestRecord: history.path } });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
