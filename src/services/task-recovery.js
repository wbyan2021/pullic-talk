"use strict";

import { createHash, randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_STATES = new Set(["failed", "interrupted", "stopped", "exited"]);
const RECOVERABLE_STATES = new Set(["failed", "interrupted"]);
const ACTIVE_STATES = new Set(["running", "stopping"]);
const MAX_PREVIEWS = 64;
const DEFAULT_PREVIEW_TTL_MS = 60_000;

export class TaskRecoveryError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "TaskRecoveryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function assertTaskId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TaskRecoveryError("recovery_task_not_found");
  return value;
}

function safeCode(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const clean = value.trim().slice(0, 64);
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(clean) ? clean : fallback;
}

function snapshotData(wrapper) {
  const snapshot = wrapper?.snapshot ?? wrapper;
  return snapshot && typeof snapshot === "object" ? snapshot : {};
}

function headOf(snapshot) {
  const value = snapshotData(snapshot).headCommit;
  return value && typeof value.hash === "string" ? value.hash.slice(0, 128) : null;
}

function changedCount(snapshot) {
  const counts = snapshotData(snapshot).counts;
  if (!counts || typeof counts !== "object") return 0;
  return ["staged", "unstaged", "untracked", "conflicted"]
    .reduce((sum, key) => sum + (Number.isInteger(counts[key]) && counts[key] >= 0 ? counts[key] : 0), 0);
}

function safeSnapshot(snapshot) {
  const source = snapshotData(snapshot);
  const count = changedCount(source);
  return {
    branch: typeof source.branch === "string" ? source.branch.slice(0, 256) : null,
    head: headOf(source),
    worktree: count > 0 ? "modified" : "clean",
    changedCount: count,
    truncated: Boolean(source.truncated),
  };
}

function fingerprint(values) {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function sourceDetails(record) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const created = events.find((event) => event?.type === "task_created");
  const terminal = [...events].reverse().find((event) => TERMINAL_STATES.has(event?.type));
  const acceptance = [...events].reverse().find((event) => event?.type === "acceptance");
  const data = created?.data && typeof created.data === "object" ? created.data : {};
  const terminalData = terminal?.data && typeof terminal.data === "object" ? terminal.data : {};
  const task = typeof data.task === "string" ? data.task : null;
  const sourceProjectId = typeof data.projectId === "string" ? data.projectId : record?.projectId;
  const acceptanceStatus = typeof acceptance?.data?.acceptanceStatus === "string"
    ? acceptance.data.acceptanceStatus
    : "pending";
  return {
    events,
    created,
    terminal,
    terminalSeq: Number.isInteger(terminal?.seq) ? terminal.seq : null,
    state: terminal?.type ?? null,
    reasonCode: safeCode(terminalData.code ?? terminalData.reason),
    task,
    sourceProjectId,
    acceptanceStatus,
    before: data.before ?? null,
  };
}

function isAccepted(details) {
  return details.acceptanceStatus === "accepted";
}

export function createTaskRecovery({
  projectBoundary,
  blackboxStore,
  taskEvidence,
  now = () => Date.now(),
  previewTtlMs = DEFAULT_PREVIEW_TTL_MS,
  idFactory = () => `preview_${randomUUID().replaceAll("-", "")}`,
} = {}) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");
  if (!blackboxStore) throw new TypeError("blackboxStore is required");
  if (!taskEvidence) throw new TypeError("taskEvidence is required");

  const previews = new Map();

  async function activeProject() {
    let status;
    try { status = await projectBoundary.getStatus(); }
    catch { throw new TaskRecoveryError("recovery_internal_error", { retryable: true }); }
    const active = status?.active && typeof status.active === "object" ? status.active : null;
    if (!active) throw new TaskRecoveryError("recovery_project_stale");
    if (active.stale || typeof active.id !== "string" || typeof active.repoRoot !== "string") {
      throw new TaskRecoveryError("recovery_project_stale");
    }
    return active;
  }

  async function readSource(active, taskId) {
    assertTaskId(taskId);
    let record;
    try {
      record = await blackboxStore.readTask({ projectId: active.id, taskId });
    } catch (error) {
      if (error?.code === "task_not_found") throw new TaskRecoveryError("recovery_task_not_found");
      throw new TaskRecoveryError("recovery_internal_error", { retryable: true });
    }
    const details = sourceDetails(record);
    if (details.sourceProjectId !== active.id) throw new TaskRecoveryError("recovery_not_eligible");
    if (details.state === null || !TERMINAL_STATES.has(details.state)) throw new TaskRecoveryError("recovery_not_eligible");
    if (!RECOVERABLE_STATES.has(details.state) || isAccepted(details)) throw new TaskRecoveryError("recovery_not_eligible");
    if (!details.task || !details.task.trim()) throw new TaskRecoveryError("recovery_payload_unavailable");
    return { record, details };
  }

  async function currentSnapshot(active) {
    try {
      const captured = await taskEvidence.captureSnapshot();
      if (captured?.projectId !== active.id || captured?.repoRoot !== active.repoRoot) {
        throw new TaskRecoveryError("recovery_project_stale");
      }
      return captured;
    } catch (error) {
      if (error instanceof TaskRecoveryError) throw error;
      if (["no_project_selected", "project_stale"].includes(error?.code)) {
        throw new TaskRecoveryError("recovery_project_stale");
      }
      throw new TaskRecoveryError("recovery_internal_error", { retryable: true });
    }
  }

  async function executionBusy() {
    try {
      const status = await taskEvidence.getStatus();
      return ACTIVE_STATES.has(status?.state);
    } catch {
      throw new TaskRecoveryError("recovery_internal_error", { retryable: true });
    }
  }

  function makePreviewId() {
    const generated = idFactory();
    if (typeof generated !== "string" || !ID_PATTERN.test(generated)) {
      throw new TaskRecoveryError("recovery_internal_error", { retryable: true });
    }
    return generated;
  }

  function previewPayload(entry) {
    return {
      eligible: true,
      sourceTaskId: entry.sourceTaskId,
      sourceState: entry.sourceState,
      reasonCode: entry.reasonCode,
      projectId: entry.projectId,
      branch: entry.current.branch,
      head: entry.current.head,
      worktree: entry.current.worktree,
      changedCount: entry.current.changedCount,
      beforeHead: headOf(entry.before),
      previewId: entry.previewId,
      expiresAt: entry.expiresAt,
      confirmationRequired: true,
      fileRollback: "not_included",
    };
  }

  async function appendSourceEvent(active, taskId, type, data) {
    try {
      await blackboxStore.appendEvent({
        projectId: active.id,
        taskId,
        type,
        data,
        allowAfterTerminal: true,
      });
    } catch {
      throw new TaskRecoveryError("recovery_internal_error", { retryable: true });
    }
  }

  async function preview({ taskId } = {}) {
    const active = await activeProject();
    const source = await readSource(active, taskId);
    const current = safeSnapshot(await currentSnapshot(active));
    const before = source.details.before;
    const entry = {
      sourceTaskId: taskId,
      sourceState: source.details.state,
      reasonCode: source.details.reasonCode,
      projectId: active.id,
      before,
      current,
      fingerprint: fingerprint({
        sourceTaskId: taskId,
        sourceProjectId: source.details.sourceProjectId,
        terminalSeq: source.details.terminalSeq,
        projectId: active.id,
        branch: current.branch,
        head: current.head,
        changedCount: current.changedCount,
      }),
      previewId: makePreviewId(),
      expiresAt: new Date(now() + Math.max(1_000, Number(previewTtlMs) || DEFAULT_PREVIEW_TTL_MS)).toISOString(),
      task: source.details.task,
      used: false,
    };
    previews.set(entry.previewId, entry);
    while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value);
    await appendSourceEvent(active, taskId, "recovery_previewed", {
      sourceState: entry.sourceState,
      reasonCode: entry.reasonCode,
      previewId: entry.previewId,
    });
    return previewPayload(entry);
  }

  async function start({ taskId, previewId, confirmed = false } = {}) {
    assertTaskId(taskId);
    if (confirmed !== true) throw new TaskRecoveryError("recovery_confirmation_required");
    const entry = previews.get(previewId);
    if (!entry || entry.used || entry.sourceTaskId !== taskId || now() >= Date.parse(entry.expiresAt)) {
      throw new TaskRecoveryError("recovery_preview_expired");
    }
    // 句柄在第一个 await 之前同步消费：并发确认同一 preview 不能双双通过检查
    entry.used = true;
    const active = await activeProject();
    const source = await readSource(active, taskId);
    if (await executionBusy()) throw new TaskRecoveryError("recovery_busy");
    const current = safeSnapshot(await currentSnapshot(active));
    const currentFingerprint = fingerprint({
      sourceTaskId: taskId,
      sourceProjectId: source.details.sourceProjectId,
      terminalSeq: source.details.terminalSeq,
      projectId: active.id,
      branch: current.branch,
      head: current.head,
      changedCount: current.changedCount,
    });
    if (currentFingerprint !== entry.fingerprint) throw new TaskRecoveryError("recovery_preview_expired");

    await appendSourceEvent(active, taskId, "recovery_confirmed", {
      sourceState: entry.sourceState,
      reasonCode: entry.reasonCode,
      previewId: entry.previewId,
    });
    let runId;
    try {
      runId = await taskEvidence.start(entry.task, {
        recoveryOfTaskId: taskId,
        recoveryReasonCode: entry.reasonCode,
      });
    } catch (error) {
      await appendSourceEvent(active, taskId, "recovery_failed", { code: safeCode(error?.code, "recovery_start_failed") }).catch(() => {});
      throw new TaskRecoveryError("recovery_start_failed", { retryable: error?.retryable === true });
    }
    let evidence;
    try { evidence = await taskEvidence.getEvidenceStatus(); }
    catch { evidence = null; }
    const newTaskId = typeof evidence?.taskId === "string" ? evidence.taskId : null;
    if (!newTaskId) {
      await appendSourceEvent(active, taskId, "recovery_failed", { code: "recovery_start_failed" }).catch(() => {});
      throw new TaskRecoveryError("recovery_start_failed", { retryable: true });
    }
    await appendSourceEvent(active, taskId, "recovery_started", {
      newTaskId,
      runId: typeof runId === "string" ? runId : null,
      sourceState: entry.sourceState,
    });
    return { ok: true, sourceTaskId: taskId, taskId: newTaskId, runId: typeof runId === "string" ? runId : null };
  }

  async function getStatus() {
    let active;
    try {
      active = await activeProject();
    } catch (error) {
      if (error?.code === "recovery_project_stale") {
        return { available: false, sourceTaskId: null, sourceState: null, reasonCode: null, state: "stale" };
      }
      throw error;
    }
    if (await executionBusy()) return { available: false, sourceTaskId: null, sourceState: null, reasonCode: null, state: "busy" };
    let taskIds;
    try { taskIds = await blackboxStore.listTasks({ projectId: active.id }); }
    catch { throw new TaskRecoveryError("recovery_internal_error", { retryable: true }); }
    const candidates = [];
    for (const taskId of taskIds) {
      try {
        const source = await readSource(active, taskId);
        const terminalAt = source.details.terminal?.at ?? "";
        candidates.push({ taskId, source, terminalAt });
      } catch (error) {
        if (error.code !== "recovery_not_eligible" && error.code !== "recovery_payload_unavailable" && error.code !== "recovery_task_not_found") throw error;
      }
    }
    candidates.sort((a, b) => a.terminalAt.localeCompare(b.terminalAt) || a.taskId.localeCompare(b.taskId));
    const latest = candidates.at(-1);
    return latest
      ? { available: true, sourceTaskId: latest.taskId, sourceState: latest.source.details.state, reasonCode: latest.source.details.reasonCode, state: "previewable" }
      : { available: false, sourceTaskId: null, sourceState: null, reasonCode: null, state: "not_available" };
  }

  return { getStatus, preview, start };
}
