"use strict";

import { GitInspectorError } from "./git-inspector.js";
import { REDACTION_MARKER, redactText } from "./safe-redactor.js";

const MAX_ENTRIES = 200;
const MAX_PATH_LENGTH = 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RECOVERY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SNAPSHOT_FIELDS = [
  "repoRoot", "branch", "detached", "hasCommits", "headCommit",
  "counts", "entries", "truncated", "remotes", "inspectedAt",
];

export class TaskEvidenceError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "TaskEvidenceError";
    this.code = code;
    this.retryable = retryable;
  }
}

function wrapError(error) {
  if (error instanceof TaskEvidenceError) return error;
  if (error instanceof GitInspectorError) {
    const retryable = error.retryable === true;
    const code = error.code === "path_not_found" || error.code === "not_a_git_repo"
      ? "project_stale"
      : error.code;
    return new TaskEvidenceError(code, { retryable });
  }
  return new TaskEvidenceError("internal_error", { retryable: true });
}

function copyCounts(counts) {
  const clean = {};
  for (const key of ["staged", "unstaged", "untracked", "conflicted"]) {
    if (Number.isInteger(counts?.[key]) && counts[key] >= 0) clean[key] = counts[key];
  }
  return clean;
}

function sanitizeSnapshot(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (!(field in source)) continue;
    if (field === "repoRoot" || field === "branch" || field === "inspectedAt") {
      if (typeof source[field] === "string" && source[field].length <= MAX_PATH_LENGTH) {
        result[field] = source[field];
      }
    } else if (field === "headCommit") {
      if (source[field] && typeof source[field] === "object") {
        result.headCommit = {
          hash: typeof source[field].hash === "string" ? source[field].hash.slice(0, 128) : null,
          date: typeof source[field].date === "string" ? source[field].date.slice(0, 32) : null,
          subject: typeof source[field].subject === "string" ? source[field].subject.slice(0, 200) : null,
        };
      } else {
        result.headCommit = null;
      }
    } else if (field === "counts") {
      result.counts = copyCounts(source[field]);
    } else if (field === "entries") {
      result.entries = Array.isArray(source[field])
        ? source[field].slice(0, MAX_ENTRIES).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          if (typeof entry.status !== "string" || typeof entry.path !== "string") return [];
          return [{ status: entry.status.slice(0, 2), path: entry.path.slice(0, MAX_PATH_LENGTH) }];
        })
        : [];
    } else if (field === "remotes") {
      result.remotes = Array.isArray(source[field])
        ? source[field].filter((remote) => typeof remote === "string").slice(0, 20).map((remote) => remote.slice(0, MAX_PATH_LENGTH))
        : [];
    } else if (field === "detached" || field === "hasCommits" || field === "truncated") {
      result[field] = Boolean(source[field]);
    }
  }
  return result;
}

function entryMap(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  return new Map(entries.map((entry) => [entry.path, entry.status]));
}

function safeText(value, maxBytes = 8 * 1024) {
  const result = redactText(typeof value === "string" ? value : "", { maxBytes });
  return result.withheld ? REDACTION_MARKER : result.text;
}

function safePayload(value, depth = 0) {
  if (typeof value === "string") return safeText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) return REDACTION_MARKER;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safePayload(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) output[key] = safePayload(item, depth + 1);
    return output;
  }
  return REDACTION_MARKER;
}

function normalizeRecoveryOptions(options) {
  if (options === undefined || options === null) return null;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TaskEvidenceError("invalid_recovery_metadata");
  }
  const sourceTaskId = options.recoveryOfTaskId;
  const reasonCode = options.recoveryReasonCode;
  if (typeof sourceTaskId !== "string" || !TASK_ID_PATTERN.test(sourceTaskId)) {
    throw new TaskEvidenceError("invalid_recovery_metadata");
  }
  if (typeof reasonCode !== "string" || !RECOVERY_CODE_PATTERN.test(reasonCode)) {
    throw new TaskEvidenceError("invalid_recovery_metadata");
  }
  return {
    recoveryOfTaskId: sourceTaskId,
    recoveryReasonCode: reasonCode,
  };
}

function terminalForDone(data) {
  if (data?.state === "stopped") return "stopped";
  if (data?.state === "exited" && data?.exitCode === 0) return "exited";
  return "failed";
}

function compactSnapshot(wrapper) {
  const snapshot = wrapper?.snapshot ?? wrapper;
  if (!snapshot || typeof snapshot !== "object") return null;
  const counts = snapshot.counts && typeof snapshot.counts === "object" ? snapshot.counts : {};
  return {
    repoRoot: typeof snapshot.repoRoot === "string" ? snapshot.repoRoot : null,
    branch: typeof snapshot.branch === "string" ? snapshot.branch : null,
    head: snapshot.headCommit?.hash ?? null,
    worktree: (Number(counts.staged) + Number(counts.unstaged) + Number(counts.untracked) + Number(counts.conflicted)) > 0 ? "modified" : "clean",
    changedPaths: Array.isArray(snapshot.entries) ? snapshot.entries.slice(0, MAX_ENTRIES).map((entry) => entry.path).filter(Boolean) : [],
    truncated: Boolean(snapshot.truncated),
  };
}

export function createTaskEvidence({
  projectBoundary,
  gitInspector,
  blackboxStore,
  piExecutor = null,
  now = () => Date.now(),
  taskIdFactory = null,
} = {}) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");
  if (!gitInspector) throw new TypeError("gitInspector is required");
  if (!blackboxStore) throw new TypeError("blackboxStore is required");

  let taskCounter = 0;
  let current = null;
  let starting = false;
  let unsubscribePi = null;
  let eventQueue = Promise.resolve();
  const listeners = new Set();

  function createTaskId() {
    const generated = typeof taskIdFactory === "function"
      ? taskIdFactory()
      : `task_${now().toString(36)}_${(++taskCounter).toString(36)}`;
    if (typeof generated !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(generated)) {
      throw new TaskEvidenceError("invalid_task_id");
    }
    return generated;
  }

  async function captureSnapshot() {
    let status;
    try {
      status = await projectBoundary.getStatus();
    } catch {
      throw new TaskEvidenceError("internal_error", { retryable: true });
    }
    const active = status?.active;
    if (!active) throw new TaskEvidenceError("no_project_selected");
    if (active.stale) throw new TaskEvidenceError("project_stale");
    if (typeof active.id !== "string" || typeof active.repoRoot !== "string") {
      throw new TaskEvidenceError("project_stale");
    }
    let inspection;
    try {
      inspection = await gitInspector.inspect(active.repoRoot);
    } catch (error) {
      throw wrapError(error);
    }
    const snapshot = sanitizeSnapshot({ ...inspection, repoRoot: active.repoRoot });
    return {
      projectId: active.id,
      repoRoot: active.repoRoot,
      capturedAt: snapshot.inspectedAt ?? new Date(now()).toISOString(),
      snapshot,
    };
  }

  function classifySnapshots(before, after) {
    const beforeSnapshot = before?.snapshot ?? before;
    const afterSnapshot = after?.snapshot ?? after;
    if (!beforeSnapshot || !afterSnapshot || beforeSnapshot.truncated || afterSnapshot.truncated) {
      return {
        certainty: "unknown",
        reason: "snapshot_truncated",
        causality: "not_proven",
        newPaths: [],
        changedPaths: [],
        preexistingPaths: [],
      };
    }
    if (before.repoRoot && after.repoRoot && before.repoRoot !== after.repoRoot) {
      return {
        certainty: "unknown",
        reason: "project_changed",
        causality: "not_proven",
        newPaths: [],
        changedPaths: [],
        preexistingPaths: [],
      };
    }
    const beforeEntries = entryMap(beforeSnapshot);
    const afterEntries = entryMap(afterSnapshot);
    const newPaths = [];
    const changedPaths = [];
    const preexistingPaths = [];
    for (const [filePath, status] of afterEntries) {
      if (!beforeEntries.has(filePath)) newPaths.push(filePath);
      else {
        preexistingPaths.push(filePath);
        if (beforeEntries.get(filePath) !== status) changedPaths.push(filePath);
      }
    }
    return {
      certainty: "observed",
      reason: null,
      causality: "not_proven",
      newPaths: newPaths.slice(0, MAX_ENTRIES),
      changedPaths: changedPaths.slice(0, MAX_ENTRIES),
      preexistingPaths: preexistingPaths.slice(0, MAX_ENTRIES),
    };
  }

  function emit(type, data) {
    const safe = safePayload(data);
    if (current) {
      current.events.push({ type, data: safe });
      if (current.events.length > 256) current.events.splice(0, current.events.length - 256);
    }
    for (const listener of [...listeners]) {
      try { listener(type, safe); } catch { /* subscriber failures are isolated */ }
    }
  }

  function appendEvent(type, data, { allowAfterTerminal = false } = {}) {
    if (!current || (current.closed && !allowAfterTerminal)) return Promise.resolve(null);
    const task = current;
    // 链上带 rejection 处理：一次失败的 append 不能让整条队列永久中毒
    //（否则后续所有事件与收口静默丢失，status/overview 永久 500）
    const run = async () => {
      const event = await blackboxStore.appendEvent({
        projectId: task.projectId,
        taskId: task.taskId,
        type,
        data: safePayload(data),
        allowAfterTerminal,
      });
      return event;
    };
    eventQueue = eventQueue.then(run, run);
    return eventQueue;
  }

  async function finishTask(type, data = {}) {
    if (!current || current.closed || current.finishing) return;
    const task = current;
    task.finishing = true;
    await appendEvent("pi_finished", {
      state: data.state ?? type,
      exitCode: data.exitCode ?? null,
      truncated: Boolean(data.truncated),
      durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null,
    });
    let after;
    try {
      after = await captureSnapshot();
    } catch (error) {
      after = {
        projectId: task.projectId,
        repoRoot: task.repoRoot,
        snapshot: { certainty: "unknown", reason: "after_snapshot_failed", code: error.code ?? "internal_error" },
      };
    }
    const classification = after.snapshot?.certainty === "unknown"
      ? { certainty: "unknown", reason: after.snapshot.reason, causality: "not_proven", newPaths: [], changedPaths: [], preexistingPaths: [] }
      : classifySnapshots(task.before, after);
    await appendEvent("after_snapshot", { ...after, classification });
    eventQueue = eventQueue.then(() => blackboxStore.closeTask({
      projectId: task.projectId,
      taskId: task.taskId,
      type,
      data: {
        state: data.state ?? type,
        exitCode: data.exitCode ?? null,
        truncated: Boolean(data.truncated),
        durationMs: Number.isFinite(data.durationMs) ? data.durationMs : null,
      },
    }));
    await eventQueue;
    task.closed = true;
    task.finishing = false;
    task.state = type;
    task.executionStatus = type;
    task.after = after;
    task.gitEvidence = classification;
    task.exitCode = data.exitCode ?? null;
    task.durationMs = Number.isFinite(data.durationMs) ? data.durationMs : null;
    if (unsubscribePi) {
      try { unsubscribePi(); } catch { /* already unsubscribed */ }
      unsubscribePi = null;
    }
    emit("done", {
      state: type,
      exitCode: task.exitCode,
      truncated: Boolean(data.truncated),
      durationMs: task.durationMs,
    });
  }

  function handlePiEvent(type, data) {
    if (!current || current.closed) return;
    if (type === "start") return; // start is recorded once after executor.start resolves
    if (type === "chunk") {
      const text = safeText(data?.text);
      appendEvent("output_chunk", { text }).then(() => emit("chunk", { text })).catch(() => {});
      return;
    }
    if (type === "status") {
      const payload = { state: typeof data?.state === "string" ? data.state : "unknown" };
      appendEvent("state_changed", payload).then(() => emit("status", payload)).catch(() => {});
      return;
    }
    if (type === "done") {
      if (current.completionPromise) return;
      current.completionPromise = finishTask(terminalForDone(data), data).catch(() => {
        // Keep the task open only when storage itself has failed; status exposes a safe error.
        if (current) current.lastError = { code: "evidence_write_failed", retryable: true };
      });
    }
  }

  async function start(rawTask, options = undefined) {
    if (!piExecutor) throw new TaskEvidenceError("internal_error", { retryable: true });
    // 并发占位：busy 检查与 current 赋值之间隔着快照子进程，必须用同步标志位封住窗口
    if (starting || (current && !current.closed && ["creating", "running", "stopping"].includes(current.state))) {
      throw new TaskEvidenceError("busy");
    }
    if (typeof rawTask !== "string" || !rawTask.trim() || rawTask.length > 4000 || rawTask.includes("\u0000")) {
      throw new TaskEvidenceError("invalid_task");
    }
    starting = true;
    try {
      return await startClaimed(rawTask, options);
    } finally {
      starting = false;
    }
  }

  async function startClaimed(rawTask, options = undefined) {
    const recovery = normalizeRecoveryOptions(options);
    const before = await captureSnapshot();
    const taskId = createTaskId();
    const task = {
      taskId,
      runId: null,
      projectId: before.projectId,
      repoRoot: before.repoRoot,
      before,
      state: "creating",
      startedAt: new Date(now()).toISOString(),
      exitCode: null,
      durationMs: null,
      closed: false,
      events: [],
      lastError: null,
      finishing: false,
      task: safeText(rawTask),
      after: null,
      gitEvidence: null,
      executionStatus: "running",
      validation: { result: "not_run", exitCode: null, output: "", withheld: false, truncated: false },
      acceptanceStatus: "pending",
      handoffWritten: false,
      recoveryOfTaskId: recovery?.recoveryOfTaskId ?? null,
      recoveryReasonCode: recovery?.recoveryReasonCode ?? null,
    };
    current = task;
    try {
      await blackboxStore.beginTask({
        projectId: task.projectId,
        taskId: task.taskId,
        data: {
          runId: null,
          task: safeText(rawTask),
          projectId: task.projectId,
          repoRoot: task.repoRoot,
          before: task.before,
          ...(recovery ? {
            recoveryOfTaskId: recovery.recoveryOfTaskId,
            recoveryReasonCode: recovery.recoveryReasonCode,
          } : {}),
        },
      });
      await appendEvent("before_snapshot", task.before);
    } catch (error) {
      current = null;
      throw error;
    }
    try {
      const runId = await piExecutor.start(rawTask);
      task.runId = typeof runId === "string" ? runId : null;
      task.state = "running";
      await appendEvent("pi_started", { runId: task.runId, startedAt: task.startedAt });
      if (recovery) {
        await appendEvent("recovery_started", {
          sourceTaskId: recovery.recoveryOfTaskId,
          reasonCode: recovery.recoveryReasonCode,
        });
      }
      emit("start", { runId: task.runId, startedAt: task.startedAt });
      unsubscribePi = piExecutor.subscribe(handlePiEvent);
      // A very short Pi process may have completed before subscribe; replay is intentional.
      const status = await piExecutor.getStatus();
      if (status?.state === "exited" || status?.state === "stopped" || status?.state === "error") {
        task.state = status.state === "error" ? "failed" : status.state;
        if (task.completionPromise) await task.completionPromise;
      }
      return task.runId;
    } catch (error) {
      task.state = "failed";
      task.executionStatus = "failed";
      task.lastError = { code: error?.code ?? "spawn_failed", retryable: error?.retryable === true };
      await appendEvent("state_changed", { state: "failed", code: task.lastError.code });
      await eventQueue;
      await blackboxStore.closeTask({
        projectId: task.projectId,
        taskId: task.taskId,
        type: "failed",
        data: task.lastError,
      });
      task.closed = true;
      throw error;
    }
  }

  async function stop() {
    if (!piExecutor) throw new TaskEvidenceError("internal_error", { retryable: true });
    const status = await piExecutor.stop();
    if (current && !current.closed && !current.finishing && status?.state === "stopped") {
      current.completionPromise = finishTask("stopped", status);
      await current.completionPromise;
    } else if (current?.completionPromise) {
      await current.completionPromise;
    }
    return getStatus();
  }

  async function getStatus() {
    const base = piExecutor ? await piExecutor.getStatus() : null;
    if (!current) return base ? { ...safePayload(base), taskId: null, projectId: null } : { state: "idle", taskId: null, projectId: null };
    if (current.completionPromise) await current.completionPromise;
    await eventQueue;
    const clean = base ? safePayload(base) : {};
    return {
      ...clean,
      // piExecutor 的内部 starting 态不外泄：任务尚在 creating/running 语义内
      state: current.closed
        ? current.state
        : (clean.state === "starting" ? current.state : (clean.state ?? current.state)),
      runId: current.runId ?? clean.runId ?? null,
      taskId: current.taskId,
      projectId: current.projectId,
      startedAt: current.startedAt,
      exitCode: current.closed ? current.exitCode : (clean.exitCode ?? null),
      durationMs: current.closed ? current.durationMs : (clean.durationMs ?? null),
      task: safeText(clean.task ?? null),
      output: safeText(clean.output ?? ""),
      lastError: current.lastError ?? (clean.lastError ? { code: clean.lastError.code, retryable: Boolean(clean.lastError.retryable) } : null),
    };
  }

  async function getEvidenceStatus() {
    if (!current) {
      return {
        taskId: null,
        projectId: null,
        repoRoot: null,
        runId: null,
        state: "idle",
        executionStatus: "idle",
        before: null,
        after: null,
        gitEvidence: null,
        validation: { result: "not_run" },
        evidence: { execution: "unknown", git: "unknown", validation: "not_run" },
        acceptanceStatus: "pending",
        task: null,
        lastError: null,
      };
    }
    if (current.completionPromise) await current.completionPromise;
    await eventQueue;
    const execution = ["exited", "stopped", "failed", "interrupted"].includes(current.executionStatus)
      ? "verified"
      : "unknown";
    const git = current.gitEvidence && current.gitEvidence.certainty !== "unknown" ? "verified" : "unknown";
    return {
      taskId: current.taskId,
      projectId: current.projectId,
      repoRoot: current.repoRoot,
      runId: current.runId,
      state: current.state,
      executionStatus: current.executionStatus,
      before: compactSnapshot(current.before),
      after: compactSnapshot(current.after),
      gitEvidence: current.gitEvidence ? safePayload(current.gitEvidence) : null,
      validation: safePayload(current.validation),
      evidence: { execution, git, validation: current.validation?.result ?? "not_run" },
      acceptanceStatus: current.acceptanceStatus,
      task: safeText(current.task),
      recoveryOfTaskId: current.recoveryOfTaskId,
      recoveryReasonCode: current.recoveryReasonCode,
      lastError: current.lastError ? { code: current.lastError.code, retryable: Boolean(current.lastError.retryable) } : null,
    };
  }

  async function recordValidation(result) {
    if (!current) throw new TaskEvidenceError("no_task");
    if (!["exited", "stopped", "failed", "interrupted"].includes(current.executionStatus)) {
      throw new TaskEvidenceError("task_running");
    }
    const safe = safePayload(result && typeof result === "object" ? result : {});
    const normalized = {
      executable: safe.executable ?? null,
      args: Array.isArray(safe.args) ? safe.args.slice(0, 64) : [],
      cwd: safe.cwd ?? null,
      approvedByUser: safe.approvedByUser === true,
      result: ["passed", "failed", "stopped", "not_run"].includes(safe.result) ? safe.result : "failed",
      exitCode: Number.isInteger(safe.exitCode) ? safe.exitCode : null,
      output: typeof safe.output === "string" ? safe.output : "",
      withheld: safe.withheld === true,
      truncated: safe.truncated === true,
      code: safe.code ?? null,
    };
    await appendEvent("validation", normalized, { allowAfterTerminal: true });
    current.validation = normalized;
    emit("validation", normalized);
    return normalized;
  }

  async function closeTask({ acceptanceStatus = "needs_review", userConfirmed = false, handoffWritten = false } = {}) {
    if (!current) throw new TaskEvidenceError("no_task");
    if (current.completionPromise) await current.completionPromise;
    if (current.acceptanceStatus !== "pending") {
      if (current.acceptanceStatus === acceptanceStatus) return getEvidenceStatus();
      throw new TaskEvidenceError("task_already_closed");
    }
    if (!["accepted", "needs_review", "rejected"].includes(acceptanceStatus)) {
      throw new TaskEvidenceError("invalid_acceptance_status");
    }
    if (!["exited", "stopped", "failed", "interrupted"].includes(current.executionStatus)) {
      throw new TaskEvidenceError("task_running");
    }
    if (acceptanceStatus === "accepted") {
      if (current.validation?.result !== "passed") throw new TaskEvidenceError("validation_required");
      if (!current.gitEvidence || current.gitEvidence.certainty === "unknown") throw new TaskEvidenceError("evidence_required");
      if (!userConfirmed) throw new TaskEvidenceError("user_confirmation_required");
      if (!handoffWritten) throw new TaskEvidenceError("handoff_not_written");
    }
    await appendEvent("acceptance", { acceptanceStatus, userConfirmed, handoffWritten }, { allowAfterTerminal: true });
    current.acceptanceStatus = acceptanceStatus;
    current.handoffWritten = handoffWritten;
    return getEvidenceStatus();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    if (current) for (const event of current.events) {
      try { listener(event.type, event.data); } catch { /* isolated */ }
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function recoverIncomplete() {
    const recovered = await blackboxStore.recoverIncomplete();
    if (current && !current.closed) current = null;
    return recovered;
  }

  return {
    captureSnapshot,
    classifySnapshots,
    start,
    stop,
    getStatus,
    getEvidenceStatus,
    recordValidation,
    closeTask,
    subscribe,
    recoverIncomplete,
  };
}
