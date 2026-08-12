"use strict";
// ─────────────────────────────────────────────────────────────
// Project Routes · S02b 多项目边界认证 HTTP 契约（v2）
// 设计: docs/plans/2026-08-12-s02b-multi-project-design.md §5
//
// 约定（与护航路由同构）:
// - 挂载在既有 authGate 之后，全部需要本机 Token；
// - 列表 { ok: true, projects, activeProjectId }；单项操作 { ok: true, project }；
//   失败 { ok: false, code, message, action, retryable }；
// - 固定中文文案，不透传 git 原始输出、路径、项目 id 或内部错误文本；
// - 响应字段白名单，服务层多余字段一律丢弃。
// ─────────────────────────────────────────────────────────────
import { ProjectBoundaryError } from "../services/project-boundary.js";

// code → [message, action, retryable]
const ERROR_INFO = {
  invalid_path: ["输入的路径无效，请输入本地目录的绝对路径。", "检查路径后重新输入", false],
  invalid_id: ["请求缺少有效的项目标识。", "刷新项目列表后重试", false],
  path_not_found: ["找不到该路径，请检查拼写或目录是否被移动。", "检查路径后重新输入", false],
  not_a_directory: ["该路径指向文件而不是目录。", "输入项目目录的路径", false],
  forbidden_root: ["不能选择根目录或主目录本身，请选择具体的项目目录。", "选择具体的项目目录", false],
  not_a_git_repo: ["该目录不是 Git 仓库。", "选择 Git 项目目录，或先在终端初始化仓库", false],
  no_project_selected: ["当前没有已选择的项目。", "先选择一个 Git 项目", false],
  project_not_found: ["找不到指定的项目，可能已被移除。", "刷新项目列表后重试", false],
  project_stale: ["项目路径已失效（目录不存在或不再是 Git 仓库）。", "移除该项目或重新选择", false],
  git_unavailable: ["找不到本机 git 命令。", "安装 Xcode Command Line Tools 后重试", false],
  git_timeout: ["git 识别超时，仓库可能过大或磁盘繁忙。", "稍后重试", true],
  git_failed: ["git 返回了驾驶舱无法识别的结果。", "稍后重试，持续失败请检查仓库完整性", true],
  internal_error: ["项目服务暂时不可用，请重新加载后重试。", "重新加载页面", true],
};

const SAFE_HTTP_STATUS = {
  invalid_path: 400,
  invalid_id: 400,
  path_not_found: 400,
  not_a_directory: 400,
  forbidden_root: 400,
  not_a_git_repo: 400,
  no_project_selected: 400,
  project_not_found: 404,
  project_stale: 409,
  git_unavailable: 424,
  git_timeout: 504,
  git_failed: 502,
};

const UNKNOWN_ERROR = {
  ok: false,
  code: "internal_error",
  message: ERROR_INFO.internal_error[0],
  action: ERROR_INFO.internal_error[1],
  retryable: ERROR_INFO.internal_error[2],
};

const INSPECTION_FIELDS = [
  "inspectedAt", "branch", "detached", "hasCommits", "headCommit",
  "counts", "entries", "truncated", "remotes",
];

const HEAD_COMMIT_FIELDS = ["hash", "date", "subject"];
const COUNT_FIELDS = ["staged", "unstaged", "untracked", "conflicted"];

function pick(source, fields) {
  const clean = {};
  for (const key of fields) {
    if (source && key in source) clean[key] = source[key];
  }
  return clean;
}

function safeInspection(inspection) {
  if (!inspection || typeof inspection !== "object") return null;
  const clean = pick(inspection, INSPECTION_FIELDS);
  if (clean.headCommit && typeof clean.headCommit === "object") {
    clean.headCommit = pick(clean.headCommit, HEAD_COMMIT_FIELDS);
  }
  if (clean.counts && typeof clean.counts === "object") {
    clean.counts = pick(clean.counts, COUNT_FIELDS);
  }
  if (!Array.isArray(clean.entries)) clean.entries = [];
  else clean.entries = clean.entries.map((entry) => pick(entry, ["status", "path"]));
  if (!Array.isArray(clean.remotes)) clean.remotes = [];
  return clean;
}

const PROJECT_FIELDS = [
  "id", "inputPath", "resolvedPath", "repoRoot",
  "selectedAt", "stale", "inspection", "selectionSnapshotAt",
];

function safeProject(payload) {
  const clean = pick(payload, PROJECT_FIELDS);
  clean.inspection = safeInspection(payload?.inspection);
  return clean;
}

function sendError(res, error) {
  if (!(error instanceof ProjectBoundaryError) || !SAFE_HTTP_STATUS[error.code]) {
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

function sendInvalidId(res) {
  const [message, action, retryable] = ERROR_INFO.invalid_id;
  return res.status(400).json({ ok: false, code: "invalid_id", message, action, retryable });
}

// 可选 id：未提供返回 undefined；提供但非法返回 "invalid"
function optionalId(body) {
  if (body == null || !("id" in body) || body.id === undefined) return undefined;
  if (typeof body.id !== "string" || body.id.trim().length === 0) return "invalid";
  return body.id;
}

export default function projectRoutes(app, { projectBoundary }) {
  if (!projectBoundary) throw new TypeError("projectBoundary is required");

  app.get("/api/project/status", async (_req, res) => {
    try {
      const payload = await projectBoundary.getStatus();
      const projects = Array.isArray(payload.projects) ? payload.projects.map(safeProject) : [];
      res.json({ ok: true, projects, activeProjectId: payload.activeProjectId ?? null });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/project/select", async (req, res) => {
    if (typeof req.body?.path !== "string" || req.body.path.trim().length === 0) {
      const [message, action, retryable] = ERROR_INFO.invalid_path;
      return res.status(400).json({ ok: false, code: "invalid_path", message, action, retryable });
    }
    try {
      const payload = await projectBoundary.select(req.body.path);
      res.json({ ok: true, project: safeProject(payload) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/project/activate", async (req, res) => {
    const id = optionalId(req.body);
    if (id === undefined || id === "invalid") return sendInvalidId(res);
    try {
      const result = await projectBoundary.setActive(id);
      res.json({ ok: true, activeProjectId: result.activeProjectId });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/project/refresh", async (req, res) => {
    const id = optionalId(req.body);
    if (id === "invalid") return sendInvalidId(res);
    try {
      const payload = await projectBoundary.refresh(id);
      res.json({ ok: true, project: safeProject(payload) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/project/clear", async (req, res) => {
    const id = optionalId(req.body);
    if (id === "invalid") return sendInvalidId(res);
    try {
      await projectBoundary.clear(id);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  });
}
