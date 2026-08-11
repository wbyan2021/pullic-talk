"use strict";
// ─────────────────────────────────────────────────────────────
// Project Boundary Service · S02 项目边界状态机与持久化
// 设计: docs/plans/2026-08-06-s02-git-safety-boundary-design.md §7
//
// 约束:
// - 只读：本服务从不执行 Git 写操作（识别全部委托 GitInspector）；
// - 持久化文件 projects.local.json 不含秘密，且必须被 Git 忽略；
// - 写入为临时文件 + rename，避免半写状态；损坏文件静默降级为空状态；
// - 对外错误统一为 ProjectBoundaryError（含稳定 code）。
// ─────────────────────────────────────────────────────────────
import { readFile, writeFile, rename, unlink, stat } from "node:fs/promises";

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

export function createProjectBoundary({ inspector, statePath, now = () => Date.now() }) {
  let record = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    let raw;
    try {
      raw = await readFile(statePath, "utf8");
    } catch {
      return; // 文件不存在 → 空状态
    }
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.project &&
        typeof parsed.project.repoRoot === "string" &&
        typeof parsed.project.inputPath === "string" &&
        typeof parsed.project.selectedAt === "string" &&
        parsed.project.selectionSnapshot &&
        parsed.project.lastInspection
      ) {
        record = parsed.project;
      }
    } catch {
      console.warn("[project-boundary] state file unreadable; starting with no selection");
    }
  }

  async function persist() {
    const data = JSON.stringify({ version: 1, project: record }, null, 2);
    const tmpPath = `${statePath}.tmp`;
    await writeFile(tmpPath, data, "utf8");
    await rename(tmpPath, statePath);
  }

  async function dropFile() {
    try {
      await unlink(statePath);
    } catch {
      /* 不存在也视为已清空（幂等） */
    }
  }

  function buildPayload(stale) {
    if (!record) return { selected: false };
    return {
      selected: true,
      inputPath: record.inputPath,
      resolvedPath: record.resolvedPath,
      repoRoot: record.repoRoot,
      selectedAt: record.selectedAt,
      stale,
      inspection: record.lastInspection,
      selectionSnapshotAt: record.selectedAt,
    };
  }

  async function getStatus() {
    await ensureLoaded();
    if (!record) return { selected: false };
    const alive = await isExistingDir(record.repoRoot);
    return buildPayload(!alive);
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
    record = {
      inputPath: inspection.inputPath,
      resolvedPath: inspection.resolvedPath,
      repoRoot: inspection.repoRoot,
      selectedAt,
      selectionSnapshot: structuredClone(cleanInspection),
      lastInspection: cleanInspection,
    };
    try {
      await persist();
    } catch {
      throw new ProjectBoundaryError("internal_error", { retryable: true });
    }
    return buildPayload(false);
  }

  async function refresh() {
    await ensureLoaded();
    if (!record) throw new ProjectBoundaryError("no_project_selected");
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
    return buildPayload(false);
  }

  async function clear() {
    await ensureLoaded();
    record = null;
    await dropFile();
    return { selected: false };
  }

  return { getStatus, select, refresh, clear };
}
