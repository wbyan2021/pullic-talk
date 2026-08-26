"use strict";

import { REDACTION_MARKER, redactText } from "../services/safe-redactor.js";

// Read-only S05-A aggregation. This route deliberately owns no state: every
// value is projected from the existing project, evidence, execution and
// handoff services and is reduced to the fields the Overview UI needs.

const HANDOFF_SOURCE = "docs/ai-ops/NOW.md";
const ACCEPTANCE_STATES = new Set(["pending", "accepted", "needs_review", "rejected"]);
const EXECUTION_STATES = new Set(["idle", "running", "stopping", "stopped", "failed", "exited", "completed", "interrupted", "error", "unknown"]);
const EVIDENCE_STATES = new Set(["verified", "unknown", "pending", "not_run", "passed", "failed", "stopped"]);
const HANDOFF_STATES = new Set(["not_enabled", "repair_required", "conflict", "ready", "unknown", "unavailable"]);

const UNKNOWN_ERROR = {
  ok: false,
  code: "internal_error",
  message: "总览暂时不可用，请重新加载后重试。",
  action: "重新加载页面",
  retryable: true,
};

function pick(source, fields) {
  const output = {};
  for (const field of fields) if (source && field in source) output[field] = source[field];
  return output;
}

function nullableString(value, max = 1024) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

function safeHeadCommit(source) {
  if (!source || typeof source !== "object") return null;
  return {
    hash: nullableString(source.hash, 128),
    date: nullableString(source.date, 32),
    subject: nullableString(source.subject, 200),
  };
}

function safeCounts(source) {
  const counts = source && typeof source === "object" ? source : {};
  return {
    staged: Number.isInteger(counts.staged) && counts.staged >= 0 ? counts.staged : 0,
    unstaged: Number.isInteger(counts.unstaged) && counts.unstaged >= 0 ? counts.unstaged : 0,
    untracked: Number.isInteger(counts.untracked) && counts.untracked >= 0 ? counts.untracked : 0,
    conflicted: Number.isInteger(counts.conflicted) && counts.conflicted >= 0 ? counts.conflicted : 0,
  };
}

function safeInspection(source) {
  const inspection = source && typeof source === "object" ? source : {};
  return {
    branch: nullableString(inspection.branch, 256),
    headCommit: safeHeadCommit(inspection.headCommit),
    counts: safeCounts(inspection.counts),
    truncated: Boolean(inspection.truncated),
  };
}

function safeFileState(source) {
  if (!source || typeof source !== "object") return null;
  return pick(source, ["agentsPointer", "current", "records", "state"]);
}

function safeHandoff(source) {
  const handoff = source && typeof source === "object" ? source : {};
  const rawState = nullableString(handoff.state, 64);
  return {
    state: HANDOFF_STATES.has(rawState) ? rawState : (handoff.enabled === true ? "unknown" : "not_enabled"),
    currentPath: nullableString(handoff.currentPath, 256),
    recordsPath: nullableString(handoff.recordsPath, 256),
    fileState: safeFileState(handoff.fileState),
  };
}

function safeProject(source, activeProjectId) {
  if (!source || typeof source !== "object") return null;
  return {
    id: nullableString(source.id, 128),
    repoRoot: nullableString(source.repoRoot, 2048),
    stale: Boolean(source.stale),
    inspection: safeInspection(source.inspection),
    handoff: safeHandoff(source.handoff),
  };
}

function safeLastError(source) {
  if (!source || typeof source !== "object") return null;
  return {
    code: nullableString(source.code, 64),
    retryable: Boolean(source.retryable),
  };
}

function safeExecution(execution, evidence) {
  const source = execution && typeof execution === "object" ? execution : {};
  const evidenceSource = evidence && typeof evidence === "object" ? evidence : {};
  const taskId = nullableString(source.taskId ?? evidenceSource.taskId, 128);
  const projectId = nullableString(source.projectId ?? evidenceSource.projectId, 128);
  const rawState = nullableString(source.state ?? evidenceSource.state ?? evidenceSource.executionStatus, 64);
  const state = taskId ? (EXECUTION_STATES.has(rawState) ? rawState : "unknown") : "idle";
  return {
    available: Boolean(taskId),
    state,
    runId: nullableString(source.runId ?? evidenceSource.runId, 128),
    startedAt: nullableString(source.startedAt, 64),
    durationMs: Number.isFinite(source.durationMs) ? source.durationMs : null,
    taskId,
    projectId,
    lastError: safeLastError(source.lastError ?? evidenceSource.lastError),
  };
}

function safeSnapshot(source) {
  if (!source || typeof source !== "object") return null;
  const changedPaths = Array.isArray(source.changedPaths) ? source.changedPaths : [];
  return {
    branch: nullableString(source.branch, 256),
    head: nullableString(source.head, 128),
    worktree: ["clean", "modified", "unknown"].includes(source.worktree) ? source.worktree : "unknown",
    changedCount: Number.isInteger(source.changedCount) && source.changedCount >= 0
      ? source.changedCount
      : changedPaths.length,
    truncated: Boolean(source.truncated),
  };
}

function safeGitEvidence(source) {
  if (!source || typeof source !== "object") return null;
  const count = (key) => Number.isInteger(source[`${key}Count`]) && source[`${key}Count`] >= 0
    ? source[`${key}Count`]
    : (Array.isArray(source[key]) ? source[key].length : 0);
  return {
    certainty: nullableString(source.certainty, 64) ?? "unknown",
    causality: nullableString(source.causality, 64) ?? "not_proven",
    newCount: count("newPaths"),
    changedCount: count("changedPaths"),
    preexistingCount: count("preexistingPaths"),
  };
}

function safeValidation(source) {
  const validation = source && typeof source === "object" ? source : {};
  const result = nullableString(validation.result, 32) ?? "not_run";
  return {
    result: EVIDENCE_STATES.has(result) ? result : "unknown",
    exitCode: Number.isInteger(validation.exitCode) ? validation.exitCode : null,
    durationMs: Number.isFinite(validation.durationMs) ? validation.durationMs : null,
    withheld: Boolean(validation.withheld),
    truncated: Boolean(validation.truncated),
  };
}

function safeEvidence(source) {
  const evidence = source && typeof source === "object" ? source : {};
  const acceptanceStatus = ACCEPTANCE_STATES.has(evidence.acceptanceStatus)
    ? evidence.acceptanceStatus
    : "pending";
  const evidenceState = (value, fallback) => {
    const normalized = nullableString(value, 32);
    return EVIDENCE_STATES.has(normalized) ? normalized : fallback;
  };
  const executionState = nullableString(evidence.state, 64);
  const executionStatus = nullableString(evidence.executionStatus, 64);
  return {
    available: Boolean(evidence.taskId),
    taskId: nullableString(evidence.taskId, 128),
    projectId: nullableString(evidence.projectId, 128),
    state: evidence.taskId && EXECUTION_STATES.has(executionState) ? executionState : "idle",
    executionStatus: evidence.taskId && EXECUTION_STATES.has(executionStatus) ? executionStatus : "idle",
    before: safeSnapshot(evidence.before),
    after: safeSnapshot(evidence.after),
    gitEvidence: safeGitEvidence(evidence.gitEvidence),
    evidence: {
      execution: evidenceState(evidence.evidence?.execution, "unknown"),
      git: evidenceState(evidence.evidence?.git, "unknown"),
      validation: evidenceState(evidence.evidence?.validation, "not_run"),
    },
    validation: safeValidation(evidence.validation),
    acceptanceStatus,
    lastError: safeLastError(evidence.lastError),
  };
}

function safeNextAction(summary) {
  const ready = summary && summary.state === "ready" && typeof summary.nextAction === "string";
  const redacted = ready ? redactText(summary.nextAction, { maxBytes: 1_200 }) : null;
  return {
    text: ready
      ? (redacted.withheld ? REDACTION_MARKER : Array.from(redacted.text).slice(0, 300).join(""))
      : null,
    source: HANDOFF_SOURCE,
    state: ready ? "ready" : "unavailable",
  };
}

export default function overviewRoutes(app, { projectBoundary, taskEvidence, aiHandoff = null } = {}) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");
  if (!taskEvidence) throw new TypeError("taskEvidence is required");

  app.get("/api/overview", async (_req, res) => {
    try {
      const status = await projectBoundary.getStatus();
      const active = status?.active && typeof status.active === "object" ? status.active : null;
      const project = {
        selected: Boolean(active),
        activeProjectId: nullableString(status?.activeProjectId, 128),
        active: safeProject(active, status?.activeProjectId),
      };

      if (!active) {
        return res.json({
          ok: true,
          overview: {
            project,
            execution: safeExecution(null, null),
            evidence: safeEvidence(null),
            nextAction: { text: null, source: null, state: "unavailable" },
          },
        });
      }

      const evidence = await taskEvidence.getEvidenceStatus();
      const execution = typeof taskEvidence.getStatus === "function"
        ? await taskEvidence.getStatus()
        : evidence;
      const summary = typeof aiHandoff?.readSummary === "function"
        ? await aiHandoff.readSummary({ repoRoot: active.repoRoot })
        : { state: "unavailable", taskStatus: null, nextAction: null };

      return res.json({
        ok: true,
        overview: {
          project,
          execution: safeExecution(execution, evidence),
          evidence: safeEvidence(evidence),
          nextAction: safeNextAction(summary),
        },
      });
    } catch {
      return res.status(500).json(UNKNOWN_ERROR);
    }
  });
}
