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

  const state = {
    loading: false,
    busy: false,
    projects: [],        // 服务端返回的项目列表（selectedAt 升序）
    activeProjectId: null,
    error: null,         // { code, message, action }
  };
  let confirmingId = null;
  let confirmTimer = null;

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
    state.loading = true;
    state.error = null;
    render();
    try {
      const payload = await request("/api/project/status");
      state.projects = Array.isArray(payload.projects) ? payload.projects : [];
      state.activeProjectId = payload.activeProjectId || null;
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.loading = false;
      render();
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

  function button(className, text, onClick, { disabled = false } = {}) {
    const node = el("button", className, text);
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
      root.appendChild(el("p", "project-note", "正在读取项目状态…"));
    } else if (state.projects.length === 0) {
      root.appendChild(renderEmpty());
    } else {
      const list = el("div", "project-list");
      for (const project of state.projects) {
        list.appendChild(renderProjectCard(project));
      }
      root.appendChild(list);
    }

    wrap.appendChild(root);
  }

  function renderHead() {
    const head = el("div", "project-head");
    head.appendChild(el("h2", "project-title", "项目与任务系统"));
    head.appendChild(el("p", "project-sub",
      "这里管理 AI 任务的工作边界：被标记 ACTIVE 的项目，是接下来 Pi 受控执行任务时唯一允许操作的目录（S03 开放）。识别全程只读，不会修改、提交或清理你的仓库。"));
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

    const submit = button("project-btn primary", state.busy ? "识别中…" : "录入并识别", () => {
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
    box.appendChild(el("h3", "project-card-title", "尚未录入项目"));
    box.appendChild(el("p", "project-note",
      "录入后，驾驶舱会只读识别仓库的分支、改动与最近提交。它的用途是为 AI 执行划定安全边界：下一步（S03）你可以提出一条真实任务，让 Pi 只在 ACTIVE 项目的目录内工作，全程可观察、可停止。"));
    box.appendChild(el("p", "project-note",
      "本切片不会创建恢复点、不会做任何 Git 写操作；恢复能力在 S05 提供。"));
    return box;
  }

  function renderErrorCard() {
    const card = el("section", "project-card error");
    card.appendChild(el("h3", "project-card-title", "遇到问题"));
    card.appendChild(el("p", "project-error-message", state.error.message));
    card.appendChild(el("p", "project-error-action", `建议：${state.error.action}`));
    card.appendChild(button("project-btn", "知道了", () => {
      state.error = null;
      render();
    }));
    return card;
  }

  function renderProjectCard(project) {
    const isActive = project.id && project.id === state.activeProjectId;
    const box = el("section", "project-card");
    if (project.stale) box.classList.add("stale");

    // 标题行：目录名 + 徽标
    const titleRow = el("div", "project-card-head");
    titleRow.appendChild(el("h3", "project-card-name", dirName(project.repoRoot)));
    const badges = el("span", "project-card-badges");
    if (isActive) badges.appendChild(el("span", "project-badge active", "ACTIVE"));
    if (project.stale) badges.appendChild(el("span", "project-badge warn", "已失效"));
    titleRow.appendChild(badges);
    box.appendChild(titleRow);

    if (project.stale) {
      box.appendChild(el("p", "project-note", "该目录已不存在或不再是 Git 仓库。请移除后重新录入。"));
    }

    // 路径
    box.appendChild(kv("输入路径", project.inputPath));
    if (project.resolvedPath && project.resolvedPath !== project.inputPath) {
      box.appendChild(kv("解析后的真实路径", project.resolvedPath));
    }
    box.appendChild(kv("仓库根", project.repoRoot));

    // 分支与提交
    const branchRow = el("div", "project-kv");
    branchRow.appendChild(el("span", "project-kv-label", "分支"));
    const badgeWrap = el("span", "project-kv-value");
    const inspection = project.inspection || {};
    if (!inspection.hasCommits) {
      badgeWrap.appendChild(el("span", "project-badge warn", "尚无提交"));
      if (inspection.branch) badgeWrap.appendChild(el("span", "project-badge", inspection.branch));
    } else if (inspection.detached) {
      badgeWrap.appendChild(el("span", "project-badge warn", "detached HEAD"));
    } else {
      badgeWrap.appendChild(el("span", "project-badge", inspection.branch || "未知分支"));
    }
    branchRow.appendChild(badgeWrap);
    box.appendChild(branchRow);

    if (inspection.headCommit) {
      box.appendChild(kv("最近提交", `${inspection.headCommit.hash} · ${inspection.headCommit.date} · ${inspection.headCommit.subject}`));
    }

    // 计数
    const counts = inspection.counts || {};
    const grid = el("div", "project-counts");
    grid.appendChild(countCell("已暂存", counts.staged));
    grid.appendChild(countCell("未暂存", counts.unstaged));
    grid.appendChild(countCell("未跟踪", counts.untracked));
    grid.appendChild(countCell("冲突", counts.conflicted, { warn: (counts.conflicted || 0) > 0 }));
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
        list.appendChild(el("p", "project-note", "条目过多，列表已截断；计数为完整统计。"));
      }
      box.appendChild(list);
    }

    // 远端
    const remotes = Array.isArray(inspection.remotes) ? inspection.remotes : [];
    box.appendChild(kv("远端", remotes.length > 0 ? remotes.join("、") : "无远端"));
    box.appendChild(kv("录入时间", project.selectedAt || ""));

    if (isActive && !project.stale) {
      box.appendChild(el("p", "project-boundary-note", "ACTIVE：后续 Pi 任务将只在此仓库根目录内运行（S03 生效）。"));
    }

    // 操作区
    const actions = el("div", "project-actions");
    if (!isActive) {
      actions.appendChild(button("project-btn", "设为活动", () => {
        act("/api/project/activate", { id: project.id });
      }, { disabled: state.busy || project.stale }));
    }
    actions.appendChild(button("project-btn", state.busy ? "识别中…" : "重新识别", () => {
      act("/api/project/refresh", { id: project.id });
    }, { disabled: state.busy || project.stale }));

    if (confirmingId === project.id) {
      actions.appendChild(button("project-btn danger", "确认移除？再点一次", () => {
        clearConfirm();
        act("/api/project/clear", { id: project.id });
      }));
    } else {
      actions.appendChild(button("project-btn danger-outline", "移除项目", () => {
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

  function kv(label, value) {
    const row = el("div", "project-kv");
    row.appendChild(el("span", "project-kv-label", label));
    row.appendChild(el("span", "project-kv-value mono", value ?? "—"));
    return row;
  }

  function countCell(label, value, { warn = false } = {}) {
    const cell = el("div", `project-count${warn ? " warn" : ""}`);
    cell.appendChild(el("div", "project-count-num", value ?? 0));
    cell.appendChild(el("div", "project-count-label", label));
    return cell;
  }

  loadStatus();
})();
