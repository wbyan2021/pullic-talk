"use strict";

import {
  access,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { REDACTION_MARKER, redactText as defaultRedactText } from "./safe-redactor.js";

const MANAGED_MARKER = "<!-- ai-ops-managed:v1 -->";
const POINTER_BEGIN = "<!-- AI-OPS-COCKPIT:BEGIN -->";
const POINTER_END = "<!-- AI-OPS-COCKPIT:END -->";
const MAX_VALUE_BYTES = 8 * 1024;
const SENSITIVE_KEY = /(?:api[-_]?key|token|password|secret|private[-_]?key|authorization)/i;

export class AiHandoffError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "AiHandoffError";
    this.code = code;
    this.retryable = retryable;
  }
}

function assertRepoRoot(repoRoot) {
  if (typeof repoRoot !== "string" || repoRoot.trim().length === 0 || repoRoot.includes("\u0000")) {
    throw new AiHandoffError("invalid_project");
  }
  return path.resolve(repoRoot);
}

function scalar(value, redactText) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const result = redactText(String(value), { maxBytes: MAX_VALUE_BYTES });
  const clean = result.withheld ? REDACTION_MARKER : result.text;
  if (!/[\r\n]/.test(clean) && !/^[\-?:][ \t]/.test(clean)) return clean;
  return JSON.stringify(clean);
}

function safeValue(value, redactText, key = "", depth = 0) {
  if (SENSITIVE_KEY.test(key)) return REDACTION_MARKER;
  if (typeof value === "string") {
    if (/\bstderr\b\s*[:=]/i.test(value)) return REDACTION_MARKER;
    return scalar(value, redactText);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return scalar(value, redactText);
  if (depth >= 4) return REDACTION_MARKER;
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => safeValue(item, redactText, key, depth + 1));
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 64)) {
      result[childKey] = safeValue(childValue, redactText, childKey, depth + 1);
    }
    return result;
  }
  return REDACTION_MARKER;
}

function listLines(name, values, redactText) {
  const list = Array.isArray(values) ? values.slice(0, 64) : [];
  if (list.length === 0) return [`${name}:`, "  []"];
  return [`${name}:`, ...list.map((value) => `  - ${safeValue(value, redactText)}`)];
}

function objectLines(name, value, keys, redactText) {
  const source = value && typeof value === "object" ? value : {};
  const lines = [`${name}:`];
  for (const key of keys) lines.push(`  ${key}: ${safeValue(source[key], redactText, key)}`);
  return lines;
}

function renderDocument(input, redactText, { record = false } = {}) {
  const taskId = typeof input.taskId === "string" ? input.taskId : null;
  const latestRecord = input.latestRecord ?? (taskId ? `docs/ai-ops/records/${taskId}.md` : null);
  const lines = [
    MANAGED_MARKER,
    "---",
    `type: ${record ? "ai-handoff-record" : "ai-handoff-current"}`,
    "schema_version: 1",
    "project: AI·OPS COCKPIT",
    `updated_at: ${new Date(input.updatedAt).toISOString()}`,
    `current_task_id: ${safeValue(taskId, redactText)}`,
    `task_status: ${safeValue(input.taskStatus ?? "needs_review", redactText)}`,
  ];
  lines.push(...objectLines("plan", input.plan, ["source", "revision", "completed", "total", "percent"], redactText));
  lines.push(...objectLines("before", input.before, ["branch", "head", "worktree"], redactText));
  lines.push(...objectLines("after", input.after, ["branch", "head", "changedPaths"], redactText));
  lines.push(...objectLines("evidence", input.evidence, ["execution", "git", "validation"], redactText));
  lines.push("facts:");
  for (const key of ["verified", "user_confirmed", "agent_reported", "recorded_not_reverified", "unknown"]) {
    const facts = input.facts?.[key];
    const entries = Array.isArray(facts) ? facts.slice(0, 64) : [];
    lines.push(`  ${key}:`);
    if (entries.length === 0) lines.push("    []");
    else lines.push(...entries.map((value) => `    - ${safeValue(value, redactText)}`));
  }
  lines.push(...listLines("issues_and_risks", input.issuesAndRisks, redactText));
  lines.push(`next_action: ${safeValue(input.nextAction ?? "", redactText)}`);
  lines.push(`latest_record: ${safeValue(latestRecord, redactText)}`);
  if (input.sourceRunId !== undefined) lines.push(`source_run_id: ${safeValue(input.sourceRunId, redactText)}`);
  if (input.blackboxRange !== undefined) lines.push(`blackbox_range: ${safeValue(input.blackboxRange, redactText)}`);
  lines.push("---", "", record ? "# AI 交接历史记录" : "# AI 交接当前状态", "");
  lines.push(record
    ? "本记录由 AI·OPS COCKPIT 生成，只能追加，不能覆盖历史记录。"
    : "开发 AI 读取本文件后，只执行 `next_action`，并按事实等级重新验证过期信息。", "");
  return `${lines.join("\n")}\n`;
}

function initialHandoffInput() {
  return {
    taskId: null,
    taskStatus: "needs_review",
    plan: { source: "unknown", revision: "unknown", completed: 0, total: 0, percent: 0 },
    before: {},
    after: {},
    evidence: { execution: "not_run", git: "unknown", validation: "not_run" },
    facts: {
      verified: [],
      user_confirmed: [],
      agent_reported: [],
      recorded_not_reverified: [],
      unknown: ["交接文件刚初始化，尚未验证目标项目当前事实"],
    },
    issuesAndRisks: ["需要先读取目标项目规划来源并确认验收边界"],
    nextAction: "读取当前项目规划来源并确认唯一下一步",
  };
}

export function createAiHandoff({ now = () => Date.now(), fsImpl = {}, redactText = defaultRedactText } = {}) {
  const fs = {
    access: fsImpl.access ?? access,
    mkdir: fsImpl.mkdir ?? mkdir,
    readFile: fsImpl.readFile ?? readFile,
    rename: fsImpl.rename ?? rename,
    writeFile: fsImpl.writeFile ?? writeFile,
  };

  function pathsFor(repoRoot) {
    const root = assertRepoRoot(repoRoot);
    return {
      root,
      agents: path.join(root, "AGENTS.md"),
      current: path.join(root, "docs", "ai-ops", "NOW.md"),
      records: path.join(root, "docs", "ai-ops", "records"),
    };
  }

  async function exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw new AiHandoffError("io_error", { retryable: true });
    }
  }

  async function atomicWrite(filePath, content) {
    const tempPath = `${filePath}.tmp-${process.pid}-${now().toString(36)}`;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
      await fs.rename(tempPath, filePath);
    } catch (error) {
      throw new AiHandoffError(error?.code === "EEXIST" ? "write_conflict" : "io_error", { retryable: true });
    }
  }

  async function writeCurrent(input = {}) {
    const paths = pathsFor(input.repoRoot);
    if (await exists(paths.current)) {
      let current;
      try { current = await fs.readFile(paths.current, "utf8"); }
      catch { throw new AiHandoffError("io_error", { retryable: true }); }
      if (!current.includes(MANAGED_MARKER) && !current.includes("type: ai-handoff-current")) {
        throw new AiHandoffError("handoff_conflict");
      }
    }
    const content = renderDocument({ ...input, updatedAt: now() }, redactText);
    await atomicWrite(paths.current, content);
    return { status: "written", path: "docs/ai-ops/NOW.md" };
  }

  async function writeRecord(input = {}) {
    const paths = pathsFor(input.repoRoot);
    if (typeof input.taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.taskId)) {
      throw new AiHandoffError("invalid_task_id");
    }
    const target = path.join(paths.records, `${input.taskId}.md`);
    if (await exists(target)) throw new AiHandoffError("record_exists");
    const content = renderDocument({ ...input, updatedAt: now() }, redactText, { record: true });
    await atomicWrite(target, content);
    return { status: "written", path: `docs/ai-ops/records/${input.taskId}.md` };
  }

  async function classifyFile(filePath, marker, { conflict = false } = {}) {
    if (!(await exists(filePath))) return "missing";
    let content;
    try { content = await fs.readFile(filePath, "utf8"); }
    catch { throw new AiHandoffError("io_error", { retryable: true }); }
    if (content.includes(marker)) return "managed";
    return conflict ? "conflict" : "missing";
  }

  async function inspectProject({ repoRoot } = {}) {
    const paths = pathsFor(repoRoot);
    const agentsPointer = await classifyFile(paths.agents, POINTER_BEGIN);
    const current = await classifyFile(paths.current, MANAGED_MARKER, { conflict: true });
    const records = (await exists(paths.records)) ? "present" : "missing";
    let state = "not_enabled";
    if (current === "conflict") state = "conflict";
    else if (agentsPointer === "managed" && current === "managed" && records === "present") state = "ready";
    else if (agentsPointer !== "missing" || current !== "missing" || records !== "missing") state = "repair_required";
    return { agentsPointer, current, records, state };
  }

  async function enableProject({ repoRoot, allowAgentsPointer = false } = {}) {
    const paths = pathsFor(repoRoot);
    const pointer = [
      POINTER_BEGIN,
      "本项目已启用 AI 交接记录。开发 AI 必须先读取 docs/ai-ops/NOW.md，再读取 latest_record 指向的历史记录。",
      "只执行 next_action；不得把交接文件自身变化算作产品功能完成。",
      POINTER_END,
      "",
    ].join("\n");
    const currentState = await classifyFile(paths.current, MANAGED_MARKER, { conflict: true });
    if (currentState === "conflict") throw new AiHandoffError("handoff_conflict");
    const hasAgents = await exists(paths.agents);
    let currentAgents = "";
    if (hasAgents) {
      try { currentAgents = await fs.readFile(paths.agents, "utf8"); }
      catch { throw new AiHandoffError("io_error", { retryable: true }); }
    }
    const managed = currentAgents.includes(POINTER_BEGIN) && currentAgents.includes(POINTER_END);
    if (!managed && !allowAgentsPointer) throw new AiHandoffError("agents_pointer_confirmation_required");

    if (currentState === "missing") await writeCurrent({ ...initialHandoffInput(), repoRoot });
    await fs.mkdir(paths.records, { recursive: true });
    if (!managed) {
      const separator = currentAgents.length > 0 && !currentAgents.endsWith("\n") ? "\n" : "";
      await atomicWrite(paths.agents, `${currentAgents}${separator}${pointer}`);
    }
    const fileState = await inspectProject({ repoRoot });
    return {
      status: "enabled",
      paths: { current: "docs/ai-ops/NOW.md", records: "docs/ai-ops/records" },
      agentsPointer: true,
      state: fileState.state,
    };
  }

  return { writeCurrent, writeRecord, enableProject, inspectProject, pathsFor };
}
