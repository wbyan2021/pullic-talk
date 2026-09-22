"use strict";
// ─────────────────────────────────────────────────────────────
// Project Boundary Service · S02b 多项目边界状态机与持久化（v2）
// 设计: docs/plans/2026-08-12-s02b-multi-project-design.md §3–§4
//
// 约束:
// - 只读：本服务从不执行 Git 写操作（识别全部委托 GitInspector）；
// - 持久化文件 projects.local.json 不含秘密，且必须被 Git 忽略；
// - 写入为临时文件 + rename，避免半写状态；损坏文件静默降级为空状态；
// - v1 单项目状态文件在加载时自动迁移为 v2，不丢任何字段；
// - 对外错误统一为 ProjectBoundaryError（含稳定 code）。
// ─────────────────────────────────────────────────────────────
import { readFile, writeFile, rename, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

import { GitInspectorError } from "./git-inspector.js";

export class ProjectBoundaryError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "ProjectBoundaryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function wrapInspectorError(error) {
  if (error instanceof GitInspectorError) {
    return new ProjectBoundaryError(error.code, { retryable: error.retryable });
  }
  return new ProjectBoundaryError("internal_error", { retryable: true });
}

async function isExistingDir(candidate) {
  try {
    const stats = await stat(candidate);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function projectIdFor(repoRoot) {
  return createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
}

const INSPECTION_FIELDS = [
  "inspectedAt", "branch", "detached", "hasCommits", "headCommit",
  "counts", "entries", "truncated", "remotes",
];

function sanitizeInspection(inspection) {
  const clean = {};
  for (const key of INSPECTION_FIELDS) {
    if (key in inspection) clean[key] = inspection[key];
  }
  return clean;
}

function isValidRecord(record) {
  return (
    record &&
    typeof record.repoRoot === "string" &&
    typeof record.inputPath === "string" &&
    typeof record.selectedAt === "string" &&
    record.selectionSnapshot &&
    record.lastInspection
  );
}

export function createProjectBoundary({ inspector, statePath, now = () => Date.now() }) {
  let projects = new Map(); // id -> record（保持插入顺序，selectedAt 升序由重选更新维护）
  let activeProjectId = null;
  let loaded = false;
  let loadPromise = null;

  async function load() {
    loaded = true;
    let raw;
    try {
      raw = await readFile(statePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return; // 文件不存在 → 空状态
      // 其他 IO 错误（权限/损坏目录等）不能当成“空状态”：
      // 否则下一次写操作会用内存里的空数据覆盖掉真实的状态文件
      loaded = false;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[project-boundary] state file unreadable; starting with no selection");
      return;
    }
    if (parsed && parsed.version === 1 && isValidRecord(parsed.project)) {
      // v1 → v2 迁移：保留全部字段，单项目直接成为活动项目
      const record = parsed.project;
      const id = projectIdFor(record.repoRoot);
      projects.set(id, { id, ...record });
      activeProjectId = id;
      try {
        await persist();
      } catch {
        console.warn("[project-boundary] v1 state migrated in memory but v2 persist failed");
      }
      return;
    }
    if (parsed && parsed.version === 2 && parsed.projects && typeof parsed.projects === "object") {
      for (const [id, record] of Object.entries(parsed.projects)) {
        if (typeof id === "string" && isValidRecord(record)) {
          projects.set(id, { ...record, id });
        }
      }
      activeProjectId =
        typeof parsed.activeProjectId === "string" && projects.has(parsed.activeProjectId)
          ? parsed.activeProjectId
          : null;
      return;
    }
    console.warn("[project-boundary] state file has unknown shape; starting with no selection");
  }

  function ensureLoaded() {
    if (loaded) return Promise.resolve();
    // 备忘录化加载 promise：并发首调共享同一次读取，后来者不会在空状态上抢先写入
    if (!loadPromise) loadPromise = load().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  async function persist() {
    const data = JSON.stringify(
      { version: 2, activeProjectId, projects: Object.fromEntries(projects) },
      null,
      2
    );
    // 唯一临时名：并发写回不会互踩同一个 .tmp（最后一个 rename 胜出，但内容始终完整）
    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, statePath);
  }

  function buildPayload(record, stale) {
    const payload = {
      id: record.id,
      inputPath: record.inputPath,
      resolvedPath: record.resolvedPath,
      repoRoot: record.repoRoot,
      selectedAt: record.selectedAt,
      stale,
      inspection: record.lastInspection,
      selectionSnapshotAt: record.selectedAt,
    };
    if (record.handoff) payload.handoff = { ...record.handoff };
    return payload;
  }

  async function getStatus() {
    await ensureLoaded();
    const list = [];
    for (const record of projects.values()) {
      const alive = await isExistingDir(record.repoRoot);
      list.push(buildPayload(record, !alive));
    }
    list.sort((a, b) => (a.selectedAt < b.selectedAt ? -1 : a.selectedAt > b.selectedAt ? 1 : 0));
    const active = list.find((p) => p.id === activeProjectId) ?? null;
    return { projects: list, activeProjectId: active ? activeProjectId : null, active };
  }

  async function select(inputPath) {
    await ensureLoaded();
    let inspection;
    try {
      inspection = await inspector.inspect(inputPath);
    } catch (error) {
      throw wrapInspectorError(error);
    }
    const selectedAt = new Date(now()).toISOString();
    const cleanInspection = sanitizeInspection(inspection);
    const id = projectIdFor(inspection.repoRoot);
    const record = {
      id,
      inputPath: inspection.inputPath,
      resolvedPath: inspection.resolvedPath,
      repoRoot: inspection.repoRoot,
      selectedAt,
      selectionSnapshot: structuredClone(cleanInspection),
      lastInspection: cleanInspection,
    };
    projects.delete(id); // 重选保持按 selectedAt 排序的插入顺序语义
    projects.set(id, record);
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return buildPayload(record, false);
  }

  async function setActive(id) {
    await ensureLoaded();
    const record = projects.get(id);
    if (!record) throw new ProjectBoundaryError("project_not_found");
    activeProjectId = id;
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return { activeProjectId: id };
  }

  function resolveId(id) {
    if (id !== undefined && id !== null) {
      const record = projects.get(id);
      if (!record) throw new ProjectBoundaryError("project_not_found");
      return record;
    }
    if (!activeProjectId || !projects.has(activeProjectId)) {
      throw new ProjectBoundaryError("no_project_selected");
    }
    return projects.get(activeProjectId);
  }

  async function refresh(id) {
    await ensureLoaded();
    const record = resolveId(id);
    let inspection;
    try {
      inspection = await inspector.inspect(record.repoRoot);
    } catch (error) {
      if (
        error instanceof GitInspectorError &&
        (error.code === "path_not_found" || error.code === "not_a_git_repo")
      ) {
        throw new ProjectBoundaryError("project_stale");
      }
      throw wrapInspectorError(error);
    }
    record.lastInspection = sanitizeInspection(inspection);
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return buildPayload(record, false);
  }

  async function clear(id) {
    await ensureLoaded();
    const record = resolveId(id);
    projects.delete(record.id);
    if (activeProjectId === record.id) activeProjectId = null;
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return { removed: true, id: record.id };
  }

  async function enableHandoff(id, metadata = {}) {
    await ensureLoaded();
    const record = resolveId(id);
    const enabledAt = new Date(now()).toISOString();
    record.handoff = {
      enabled: true,
      enabledAt,
      currentPath: "docs/ai-ops/NOW.md",
      recordsPath: "docs/ai-ops/records",
      ...metadata,
    };
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return buildPayload(record, false);
  }

  async function getHandoff(id) {
    await ensureLoaded();
    const record = resolveId(id);
    return record.handoff ? { ...record.handoff } : null;
  }

  return { getStatus, select, setActive, refresh, clear, enableHandoff, getHandoff };
}
