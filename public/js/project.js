"use strict";
/* ═══════════════════════════════════════════
   AI·OPS COCKPIT — 项目 view（S02 Git 项目安全边界）
   - 只读识别：选择本地 Git 项目并展示工作区状态
   - 安全：所有动态内容使用 createElement/textContent，不做 HTML 字符串注入
   - 数据：一切以服务端为准，浏览器不做任何持久化
   ═══════════════════════════════════════════ */
(() => {
  const wrap = document.getElementById("project-wrap");
  if (!wrap) return;

  const state = {
    loading: false,
    busy: false,
    project: null, // { selected: false } 或完整快照
    error: null,   // { code, message, action }
  };
  let confirming = false;
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
      state.project = payload.project || { selected: false };
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function act(pathname, body, { keepErrorSource = null } = {}) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      const payload = await request(pathname, body ? { method: "POST", json: body } : { method: "POST" });
      state.project = payload.project || { selected: false };
      confirming = false;
    } catch (error) {
      state.error = pickError(error, keepErrorSource);
    } finally {
      state.busy = false;
      render();
    }
  }

  function pickError(error, fallback) {
    return {
      code: error.code || "request_failed",
      message: error.message || "请求失败，请稍后重试。",
      action: error.action || "重新加载页面",
    };
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

  function render() {
    wrap.textContent = "";
    const root = el("div", "project-root");

    root.appendChild(renderHead());

    if (state.loading) {
      root.appendChild(el("p", "project-note", "正在读取项目状态…"));
    } else if (state.error) {
      root.appendChild(renderErrorCard());
      if (!state.project || state.project.selected === false) root.appendChild(renderSelectForm());
    } else if (!state.project || state.project.selected === false) {
      root.appendChild(renderEmpty());
    } else {
      root.appendChild(renderSelected(state.project));
    }

    wrap.appendChild(root);
  }

  function renderHead() {
    const head = el("div", "project-head");
    head.appendChild(el("h2", "project-title", "项目与任务系统"));
    head.appendChild(el("p", "project-sub", "选择一个本地 Git 项目。识别全程只读：不会修改、提交或清理你的仓库。"));
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

    const submit = button("project-btn primary", state.busy ? "识别中…" : "选择并识别", () => {
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
    box.appendChild(el("h3", "project-card-title", "未选择项目"));
    box.appendChild(el("p", "project-note",
      "选择后，驾驶舱会只读识别该仓库的分支、未提交改动、未跟踪文件、最近提交与远端，并把路径记录为后续 Pi 任务的工作边界（S03 生效）。"));
    box.appendChild(el("p", "project-note",
      "本切片不会创建恢复点、不会做任何 Git 写操作；恢复能力在 S05 提供。"));
    box.appendChild(renderSelectForm());
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

  function renderSelected(project) {
    const box = el("section", "project-card");

    if (project.stale) {
      box.classList.add("stale");
      box.appendChild(el("h3", "project-card-title", "项目路径已失效"));
      box.appendChild(el("p", "project-note", "该目录已不存在或不再是 Git 仓库。请移除后重新选择。"));
    } else {
      box.appendChild(el("h3", "project-card-title", "已选择项目"));
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
    box.appendChild(kv("选择时间", project.selectedAt || ""));

    box.appendChild(el("p", "project-boundary-note", "该仓库根将作为后续 Pi 任务的工作边界（S03 生效）。"));

    // 操作区
    const actions = el("div", "project-actions");
    actions.appendChild(button("project-btn", state.busy ? "识别中…" : "重新识别", () => {
      act("/api/project/refresh");
    }, { disabled: state.busy || project.stale }));

    if (confirming) {
      actions.appendChild(button("project-btn danger", "确认移除？再点一次", () => {
        confirming = false;
        clearTimeout(confirmTimer);
        act("/api/project/clear");
      }));
    } else {
      actions.appendChild(button("project-btn danger-outline", "移除项目", () => {
        confirming = true;
        render();
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          confirming = false;
          render();
        }, 4000);
      }));
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
