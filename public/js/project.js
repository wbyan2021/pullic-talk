"use strict";
/* ═══════════════════════════════════════════
   AI·OPS COCKPIT — 项目 view（S02b 多项目并行管理）
   - 多项目录入：列表查看各自只读识别状态，逐项刷新/移除
   - 活动项目：唯一 ACTIVE 标记，作为后续 S03 Pi 任务的工作边界
   - 安全：所有动态内容使用 createElement/textContent，不做 HTML 字符串注入
   - 数据：一切以服务端为准，浏览器不做任何持久化
   ═══════════════════════════════════════════ */
(() => {
  const wrap = document.getElementById("project-wrap");
  if (!wrap) return;
  const executionPanel = document.getElementById("execution-panel");

  const state = {
    loading: false,
    busy: false,
    projects: [],        // 服务端返回的项目列表（selectedAt 升序）
    activeProjectId: null,
    error: null,         // { code, message, action }
  };
  let confirmingId = null;
  let confirmTimer = null;
  // 专注折叠：存在活动项目时，其他项目默认折叠成一行；
  // 手动展开的 id 只保留在会话内存中（浏览器不做持久化）。
  const expandedIds = new Set();
  let lastActiveProjectId = undefined;

  // ── API ──

  async function request(pathname, options) {
    const response = await window.OPS.api(pathname, options);
    let payload;
    try { payload = await response.json(); }
    catch { payload = {}; }
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.message || "请求失败，请稍后重试。");
      error.code = payload.code || "request_failed";
      error.action = payload.action || "重新加载页面";
      throw error;
    }
    return payload;
  }

  async function loadStatus() {
    const previousActiveProjectId = state.activeProjectId;
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await request("/api/project/status");
      state.projects = Array.isArray(payload.projects) ? payload.projects : [];
      state.activeProjectId = payload.activeProjectId || null;
      if (state.activeProjectId !== lastActiveProjectId) {
        // 活动项目变化（开始/切换/清空）：收起手动展开状态，让视觉重新聚焦
        expandedIds.clear();
        lastActiveProjectId = state.activeProjectId;
      }
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.loading = false;
      render();
      if (state.activeProjectId !== previousActiveProjectId) {
        window.dispatchEvent(new CustomEvent("ops:active-project-changed", {
          detail: { activeProjectId: state.activeProjectId },
        }));
      }
    }
  }

  async function act(pathname, body) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      await request(pathname, { method: "POST", json: body ?? {} });
      clearConfirm();
      await loadStatus(); // 服务端是唯一事实源
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  function pickError(error) {
    return {
      code: error.code || "request_failed",
      message: error.message || "请求失败，请稍后重试。",
      action: error.action || "重新加载页面",
    };
  }

  function clearConfirm() {
    confirmingId = null;
    clearTimeout(confirmTimer);
  }

  // ── DOM 构建（仅使用安全 API） ──

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // 固定文案使用中文主标签 + 英文辅助标签；动态路径、分支、提交和任务原文保持不变。
  const STATUS_LABELS = Object.freeze({
    active: ["活动", "Active"],
    stale: ["已失效", "Stale"],
    detached: ["游离 HEAD", "detached HEAD"],
    unknown: ["未知", "Unknown"],
    unknown_branch: ["未知分支", "Unknown Branch"],
  });

  function bilingual(zh, en) {
    const node = el("span", "bilingual");
    node.appendChild(el("span", "bilingual-zh", zh));
    node.appendChild(el("span", "bilingual-en", en));
    return node;
  }

  function bilingualBadge(zh, en, variant = "") {
    const node = bilingual(zh, en);
    node.classList.add("project-badge");
    if (variant) node.classList.add(variant);
    return node;
  }

  function bilingualElement(tag, className, zh, en) {
    const node = el(tag, className);
    node.appendChild(bilingual(zh, en));
    return node;
  }

  function statusPair(value, fallback = "unknown") {
    const key = String(value || fallback).toLowerCase();
    return STATUS_LABELS[key] || [STATUS_LABELS.unknown[0], String(value || "Unknown")];
  }

  function statusText(value, fallback = "unknown") {
    const [zh, en] = statusPair(value, fallback);
    return `${zh} ${en}`;
  }

  function appendContent(node, content) {
    if (content && typeof content === "object" && content.nodeType) node.appendChild(content);
    else node.textContent = content == null ? "" : String(content);
  }

  function button(className, text, onClick, { disabled = false } = {}) {
    const node = el("button", className);
    appendContent(node, text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  function dirName(repoRoot) {
    if (!repoRoot) return "未命名项目";
    const parts = repoRoot.split("/").filter(Boolean);
    return parts[parts.length - 1] || repoRoot;
  }

  function render() {
    wrap.textContent = "";
    const root = el("div", "project-root");

    root.appendChild(renderHead());
    root.appendChild(renderSelectForm());

    if (state.error) root.appendChild(renderErrorCard());

    if (state.loading) {
      root.appendChild(bilingualElement("p", "project-note", "正在读取项目状态…", "Loading project status…"));
    } else if (state.projects.length === 0) {
      root.appendChild(renderEmpty());
    } else {
      const list = el("div", "project-list");
      for (const project of state.projects) {
        const stack = el("div", "project-stack");
        stack.appendChild(renderProjectCard(project));
        const isActiveProject = project.id === state.activeProjectId;
        if (isActiveProject && executionPanel) {
          executionPanel.hidden = false;
          stack.appendChild(executionPanel);
        }
        list.appendChild(stack);
      }
      root.appendChild(list);
    }

    if (!state.activeProjectId && executionPanel) executionPanel.hidden = true;

    wrap.appendChild(root);
  }

  function renderHead() {
    const head = el("div", "project-head");
    head.appendChild(bilingualElement("h2", "project-title", "项目与任务系统", "Project & Task System"));
    head.appendChild(el("p", "project-sub",
      "这里管理 AI 任务的工作边界：被标记为“活动（ACTIVE）”的项目，是接下来 Pi 受控执行任务时唯一允许操作的目录（S03 开放）。识别全程只读，不会修改、提交或清理你的仓库。"));
    return head;
  }

  function renderSelectForm() {
    const form = el("form", "project-select-form");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "输入 Git 项目的本地路径，例如 /Users/你/projects/my-app";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 1024;

    const submit = button("project-btn primary", state.busy
      ? bilingual("识别中…", "Inspecting…")
      : bilingual("录入并识别", "Add & Inspect"), () => {
      const path = input.value.trim();
      if (!path) return;
      act("/api/project/select", { path });
    }, { disabled: state.busy });
    submit.type = "submit";

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const path = input.value.trim();
      if (!path) return;
      act("/api/project/select", { path });
    });

    form.appendChild(input);
    form.appendChild(submit);
    return form;
  }

  function renderEmpty() {
    const box = el("section", "project-card");
    box.appendChild(bilingualElement("h3", "project-card-title", "尚未录入项目", "No Project Yet"));
    box.appendChild(el("p", "project-note",
      "录入后，驾驶舱会只读识别仓库的分支、改动与最近提交。它的用途是为 AI 执行划定安全边界：下一步（S03）你可以提出一条真实任务，让 Pi 只在活动（ACTIVE）项目的目录内工作，全程可观察、可停止。"));
    box.appendChild(el("p", "project-note",
      "本切片不会创建恢复点、不会做任何 Git 写操作；恢复能力在 S05 提供。"));
    return box;
  }

  function renderErrorCard() {
    const card = el("section", "project-card error");
    card.appendChild(bilingualElement("h3", "project-card-title", "遇到问题", "Problem"));
    card.appendChild(el("p", "project-error-message", state.error.message));
    card.appendChild(el("p", "project-error-action", `建议：${state.error.action}`));
    card.appendChild(button("project-btn", bilingual("知道了", "Got it"), () => {
      state.error = null;
      render();
    }));
    return card;
  }

  function renderProjectCard(project) {
    const isActive = project.id && project.id === state.activeProjectId;
    const hasActive = Boolean(state.activeProjectId);
    const collapsed = hasActive && !isActive && !expandedIds.has(project.id);
    if (collapsed) return renderCollapsedCard(project);

    const box = el("section", "project-card");
    if (project.stale) box.classList.add("stale");

    // 标题行：目录名 + 徽标（+ 折叠按钮）
    const titleRow = el("div", "project-card-head");
    titleRow.appendChild(el("h3", "project-card-name", dirName(project.repoRoot)));
    const headRight = el("div", "project-card-head-right");
    const badges = el("span", "project-card-badges");
    if (isActive) badges.appendChild(bilingualBadge("活动", "ACTIVE", "active"));
    if (project.stale) badges.appendChild(bilingualBadge("已失效", "Stale", "warn"));
    headRight.appendChild(badges);
    if (hasActive && !isActive) {
      headRight.appendChild(button("project-fold-btn", bilingual("▾ 收起", "Collapse"), () => {
        expandedIds.delete(project.id);
        render();
      }));
    }
    titleRow.appendChild(headRight);
    box.appendChild(titleRow);

    if (project.stale) {
      box.appendChild(el("p", "project-note", "该目录已不存在或不再是 Git 仓库。请移除后重新录入。"));
    }

    // 路径
    box.appendChild(kv(bilingual("输入路径", "Input Path"), project.inputPath));
    if (project.resolvedPath && project.resolvedPath !== project.inputPath) {
      box.appendChild(kv(bilingual("解析后的真实路径", "Resolved Path"), project.resolvedPath));
    }
    box.appendChild(kv(bilingual("仓库根", "Repository Root"), project.repoRoot));

    // 分支与提交
    const branchRow = el("div", "project-kv");
    branchRow.appendChild(bilingual("分支", "Branch"));
    branchRow.lastChild.classList.add("project-kv-label");
    const badgeWrap = el("span", "project-kv-value");
    const inspection = project.inspection || {};
    if (!inspection.hasCommits) {
      badgeWrap.appendChild(bilingualBadge("尚无提交", "No Commits", "warn"));
      if (inspection.branch) badgeWrap.appendChild(el("span", "project-badge", inspection.branch));
    } else if (inspection.detached) {
      badgeWrap.appendChild(bilingualBadge("游离 HEAD", "detached HEAD", "warn"));
    } else {
      if (inspection.branch && inspection.branch !== "unknown") badgeWrap.appendChild(el("span", "project-badge", inspection.branch));
      else badgeWrap.appendChild(bilingualBadge("未知分支", "Unknown Branch"));
    }
    branchRow.appendChild(badgeWrap);
    box.appendChild(branchRow);

    if (inspection.headCommit) {
      box.appendChild(kv("最近提交", `${inspection.headCommit.hash} · ${inspection.headCommit.date} · ${inspection.headCommit.subject}`));
    }

    // 计数
    const counts = inspection.counts || {};
    const grid = el("div", "project-counts");
    grid.appendChild(countCell(bilingual("已暂存", "Staged"), counts.staged));
    grid.appendChild(countCell(bilingual("未暂存", "Unstaged"), counts.unstaged));
    grid.appendChild(countCell(bilingual("未跟踪", "Untracked"), counts.untracked));
    grid.appendChild(countCell(bilingual("冲突", "Conflicts"), counts.conflicted, { warn: (counts.conflicted || 0) > 0 }));
    box.appendChild(grid);

    // 文件列表
    const entries = Array.isArray(inspection.entries) ? inspection.entries : [];
    if (entries.length > 0) {
      const list = el("div", "project-entries");
      for (const entry of entries) {
        const line = el("div", "project-entry");
        line.appendChild(el("span", `project-entry-status${entry.status && entry.status.includes("U") ? " warn" : ""}`, entry.status));
        line.appendChild(el("span", "project-entry-path", entry.path));
        list.appendChild(line);
      }
      if (inspection.truncated) {
        list.appendChild(bilingualElement("p", "project-note", "条目过多，列表已截断；计数为完整统计。", "Too many entries; list truncated, counts are complete."));
      }
      box.appendChild(list);
    }

    // 远端
    const remotes = Array.isArray(inspection.remotes) ? inspection.remotes : [];
    box.appendChild(kv(bilingual("远端", "Remote"), remotes.length > 0 ? remotes.join("、") : "无远端"));
    box.appendChild(kv(bilingual("录入时间", "Added At"), project.selectedAt || ""));

    if (isActive && !project.stale) {
      const boundary = el("p", "project-boundary-note");
      boundary.appendChild(bilingual("活动项目：后续 Pi 任务将只在此仓库根目录内运行（S03 生效）。", "Active project: later Pi tasks run only inside this repository root (S03)."));
      box.appendChild(boundary);
      box.appendChild(renderHandoff(project));
    }

    // 操作区
    const actions = el("div", "project-actions");
    if (!isActive) {
      actions.appendChild(button("project-btn", bilingual("设为活动", "Set Active"), () => {
        act("/api/project/activate", { id: project.id });
      }, { disabled: state.busy || project.stale }));
    }
    actions.appendChild(button("project-btn", state.busy
      ? bilingual("识别中…", "Inspecting…")
      : bilingual("重新识别", "Refresh Status"), () => {
      act("/api/project/refresh", { id: project.id });
    }, { disabled: state.busy || project.stale }));

    if (confirmingId === project.id) {
      actions.appendChild(button("project-btn danger", bilingual("确认移除？再点一次", "Confirm Remove"), () => {
        clearConfirm();
        act("/api/project/clear", { id: project.id });
      }));
    } else {
      actions.appendChild(button("project-btn danger-outline", bilingual("移除项目", "Remove Project"), () => {
        confirmingId = project.id;
        render();
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          confirmingId = null;
          render();
        }, 4000);
      }, { disabled: state.busy }));
    }
    box.appendChild(actions);

    return box;
  }

  function renderHandoff(project) {
    const card = el("section", "project-handoff");
    const handoff = project.handoff;
    card.appendChild(bilingualElement("h4", "project-handoff-title", "AI 交接记录", "AI Handoff"));
    if (handoff && handoff.enabled) {
      const handoffState = handoff.state || "repair_required";
      if (handoffState === "conflict") {
        card.appendChild(bilingualElement("p", "project-note warn", "交接文件存在冲突，系统不会覆盖；请先人工处理后再重试。", "Handoff conflict; nothing will be overwritten. Resolve it manually and retry."));
        card.appendChild(kv(bilingual("当前交接", "Current Handoff"), handoff.currentPath || "docs/ai-ops/NOW.md"));
        card.appendChild(kv(bilingual("历史记录", "History"), handoff.recordsPath || "docs/ai-ops/records"));
        return card;
      }
      if (handoffState === "repair_required") {
        card.appendChild(bilingualElement("p", "project-note warn", "交接已授权，但文件未就绪；修复只会补齐缺失的受控文件，不覆盖已有内容。", "Handoff is authorized but not ready; repair only adds missing managed files."));
        card.appendChild(button("project-btn primary", state.busy
          ? bilingual("修复中…", "Repairing…")
          : bilingual("修复 AI 交接", "Repair AI Handoff"), () => {
          act("/api/project/handoff/enable", { id: project.id });
        }, { disabled: state.busy }));
        return card;
      }
      card.appendChild(bilingualElement("p", "project-note", "已启用且文件已就绪：每次任务完成后，AI 可读取当前状态、历史记录和唯一下一步。", "Enabled and ready: after each task, AI can read the current state, history, and one next action."));
      card.appendChild(kv(bilingual("当前交接", "Current Handoff"), handoff.currentPath || "docs/ai-ops/NOW.md"));
      card.appendChild(kv(bilingual("历史记录", "History"), handoff.recordsPath || "docs/ai-ops/records"));
      return card;
    }
    card.appendChild(bilingualElement("p", "project-note", "尚未启用。启用后会在项目内写入受控的 AI 交接入口；不会自动覆盖已有文档。", "Not enabled. Enabling adds a managed AI handoff entry without overwriting existing documents."));
    card.appendChild(button("project-btn primary", state.busy
      ? bilingual("启用中…", "Enabling…")
      : bilingual("启用 AI 交接", "Enable AI Handoff"), () => {
      act("/api/project/handoff/enable", { id: project.id });
    }, { disabled: state.busy }));
    return card;
  }

  // 折叠态卡片：单行摘要（目录名 + 徽标 + 分支/改动概要），点击展开
  function renderCollapsedCard(project) {
    const box = el("section", "project-card collapsed");
    if (project.stale) box.classList.add("stale");

    const row = el("div", "project-fold-row");
    row.appendChild(button("project-fold-btn", bilingual("▸ 展开", "Expand"), () => {
      expandedIds.add(project.id);
      render();
    }));
    row.appendChild(el("h3", "project-card-name", dirName(project.repoRoot)));
    if (project.stale) {
      row.appendChild(bilingualBadge("已失效", "Stale", "warn"));
    }
    row.appendChild(el("span", "project-fold-summary", foldSummary(project)));
    box.appendChild(row);
    return box;
  }

  function foldSummary(project) {
    if (project.stale) return "目录已失效，请移除后重新录入";
    const inspection = project.inspection || {};
    const counts = inspection.counts || {};
    const changed = (counts.staged || 0) + (counts.unstaged || 0)
      + (counts.untracked || 0) + (counts.conflicted || 0);
    const branch = inspection.detached
      ? statusText("detached")
      : (inspection.branch || statusText("unknown_branch"));
    return `${branch} · ${changed} 处改动`;
  }

  function kv(label, value) {
    const row = el("div", "project-kv");
    const labelNode = typeof label === "string" ? el("span", "project-kv-label", label) : label;
    labelNode.classList.add("project-kv-label");
    row.appendChild(labelNode);
    row.appendChild(el("span", "project-kv-value mono", value ?? "—"));
    return row;
  }

  function countCell(label, value, { warn = false } = {}) {
    const cell = el("div", `project-count${warn ? " warn" : ""}`);
    cell.appendChild(el("div", "project-count-num", value ?? 0));
    const labelNode = typeof label === "string" ? el("div", "project-count-label", label) : label;
    labelNode.classList.add("project-count-label");
    cell.appendChild(labelNode);
    return cell;
  }

  loadStatus();
})();
