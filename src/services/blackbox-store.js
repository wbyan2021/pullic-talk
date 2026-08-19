"use strict";

import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { REDACTION_MARKER, redactText } from "./safe-redactor.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TYPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL_TYPES = new Set(["exited", "stopped", "failed", "interrupted"]);
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|token|password|secret|private[-_]?key|authorization)/i;

export class BlackboxStoreError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "BlackboxStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

function assertId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new BlackboxStoreError("invalid_id");
  }
}

function assertType(value) {
  if (typeof value !== "string" || !TYPE_PATTERN.test(value)) {
    throw new BlackboxStoreError("invalid_event");
  }
}

function sanitizeValue(value, depth = 0) {
  if (typeof value === "string") {
    const result = redactText(value);
    return result.withheld ? REDACTION_MARKER : result.text;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return REDACTION_MARKER;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) result[key] = REDACTION_MARKER;
      else result[key] = sanitizeValue(item, depth + 1);
    }
    return result;
  }
  return REDACTION_MARKER;
}

function parseCompleteEvents(raw) {
  const lastNewline = raw.lastIndexOf("\n");
  const completeText = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  const lines = completeText.split("\n").filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (
        event &&
        Number.isInteger(event.seq) &&
        typeof event.at === "string" &&
        typeof event.type === "string"
      ) {
        events.push(event);
      }
    } catch {
      // A malformed line is not trusted as evidence; keep valid lines around it.
    }
  }
  return { events, completeText, hasPartial: completeText.length !== raw.length };
}

export function createBlackboxStore({
  rootDir,
  now = () => Date.now(),
  fsImpl = {},
} = {}) {
  if (typeof rootDir !== "string" || rootDir.length === 0) {
    throw new TypeError("rootDir is required");
  }

  const fs = {
    access: fsImpl.access ?? access,
    appendFile: fsImpl.appendFile ?? appendFile,
    mkdir: fsImpl.mkdir ?? mkdir,
    readFile: fsImpl.readFile ?? readFile,
    readdir: fsImpl.readdir ?? readdir,
    writeFile: fsImpl.writeFile ?? writeFile,
  };
  const locks = new Map();

  function fileFor(projectId, taskId) {
    assertId(projectId);
    assertId(taskId);
    return join(rootDir, projectId, `${taskId}.jsonl`);
  }

  async function withLock(filePath, action) {
    const previous = locks.get(filePath) ?? Promise.resolve();
    const current = previous.then(action, action);
    locks.set(filePath, current.catch(() => {}));
    return current;
  }

  async function readState(filePath) {
    let raw;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") throw new BlackboxStoreError("task_not_found");
      throw new BlackboxStoreError("io_error", { retryable: true });
    }
    return { raw, ...parseCompleteEvents(raw) };
  }

  async function repairPartialTail(filePath, state) {
    if (!state.hasPartial) return;
    try {
      await fs.writeFile(filePath, state.completeText, "utf8");
    } catch {
      throw new BlackboxStoreError("io_error", { retryable: true });
    }
  }

  async function beginTask({ projectId, taskId, data = {} } = {}) {
    const filePath = fileFor(projectId, taskId);
    return withLock(filePath, async () => {
      try {
        await fs.access(filePath);
        throw new BlackboxStoreError("task_exists");
      } catch (error) {
        if (error instanceof BlackboxStoreError) throw error;
        if (error?.code !== "ENOENT") throw new BlackboxStoreError("io_error", { retryable: true });
      }

      try {
        await fs.mkdir(join(rootDir, projectId), { recursive: true });
        const event = {
          seq: 1,
          at: new Date(now()).toISOString(),
          type: "task_created",
          data: sanitizeValue(data),
        };
        await fs.writeFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "wx" });
        return event;
      } catch (error) {
        if (error instanceof BlackboxStoreError) throw error;
        if (error?.code === "EEXIST") throw new BlackboxStoreError("task_exists");
        throw new BlackboxStoreError("io_error", { retryable: true });
      }
    });
  }

  async function appendEvent({ projectId, taskId, type, data = {}, allowAfterTerminal = false } = {}) {
    assertType(type);
    const filePath = fileFor(projectId, taskId);
    return withLock(filePath, async () => {
      const state = await readState(filePath);
      const last = state.events.at(-1);
      if (!last) throw new BlackboxStoreError("task_not_found");
      if (TERMINAL_TYPES.has(last.type) && !allowAfterTerminal) throw new BlackboxStoreError("task_closed");
      await repairPartialTail(filePath, state);
      const event = {
        seq: last.seq + 1,
        at: new Date(now()).toISOString(),
        type,
        data: sanitizeValue(data),
      };
      try {
        await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        throw new BlackboxStoreError("io_error", { retryable: true });
      }
      return event;
    });
  }

  async function closeTask({ projectId, taskId, type, data = {} } = {}) {
    if (!TERMINAL_TYPES.has(type)) throw new BlackboxStoreError("invalid_terminal_state");
    return appendEvent({ projectId, taskId, type, data });
  }

  async function readTask({ projectId, taskId } = {}) {
    const filePath = fileFor(projectId, taskId);
    const state = await readState(filePath);
    const last = state.events.at(-1);
    return {
      projectId,
      taskId,
      events: state.events,
      closed: state.events.some((event) => TERMINAL_TYPES.has(event.type)),
    };
  }

  async function recoverIncomplete() {
    let projectEntries;
    try {
      projectEntries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw new BlackboxStoreError("io_error", { retryable: true });
    }

    const recovered = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || !ID_PATTERN.test(projectEntry.name)) continue;
      let taskEntries;
      try {
        taskEntries = await fs.readdir(join(rootDir, projectEntry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const taskEntry of taskEntries) {
        if (!taskEntry.isFile() || !taskEntry.name.endsWith(".jsonl")) continue;
        const taskId = taskEntry.name.slice(0, -".jsonl".length);
        if (!ID_PATTERN.test(taskId)) continue;
        const filePath = fileFor(projectEntry.name, taskId);
        const state = await readState(filePath);
        const last = state.events.at(-1);
        if (!last || state.events.some((event) => TERMINAL_TYPES.has(event.type))) continue;
        await appendEvent({
          projectId: projectEntry.name,
          taskId,
          type: "interrupted",
          data: { reason: "service_restart" },
        });
        recovered.push({ projectId: projectEntry.name, taskId, state: "interrupted" });
      }
    }
    return recovered;
  }

  return { beginTask, appendEvent, closeTask, readTask, recoverIncomplete };
}
