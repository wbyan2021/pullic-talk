"use strict";

(() => {
  const STATUS_LABELS = Object.freeze({
    idle: ["空闲", "Idle"],
    running: ["运行中", "Running"],
    stopping: ["停止中", "Stopping"],
    stopped: ["已停止", "Stopped"],
    failed: ["失败", "Failed"],
    exited: ["已完成", "Completed"],
    completed: ["已完成", "Completed"],
    interrupted: ["已中断", "Interrupted"],
    unknown: ["未知", "Unknown"],
    pending: ["待处理", "Pending"],
    not_run: ["未运行", "Not Run"],
    passed: ["通过", "Passed"],
    needs_review: ["需复核", "Needs Review"],
    accepted: ["已接受", "Accepted"],
    rejected: ["已拒绝", "Rejected"],
    not_enabled: ["未启用", "Not Enabled"],
    unavailable: ["暂不可用", "Unavailable"],
    ready: ["已就绪", "Ready"],
    previewable: ["可恢复", "Recoverable"],
    busy: ["已有任务运行", "Busy"],
    stale: ["项目已失效", "Stale"],
    not_available: ["不可恢复", "Not Recoverable"],
  });

  let active = false;
  let timer = null;
  let requestSerial = 0;
  let controller = null;
  let lastOverview = null;

  const byId = (id) => document.getElementById(id);

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function safeValue(value, fallback = "—") {
    return value === null || value === undefined || value === "" ? fallback : String(value);
  }

  function statusText(value) {
    const key = typeof value === "string" ? value : "unknown";
    const labels = STATUS_LABELS[key] || STATUS_LABELS.unknown;
    return `${labels[0]} / ${labels[1]}`;
  }

  function addBilingual(parent, zh, en, tag = "span") {
    const wrap = element(tag, "bilingual");
    wrap.appendChild(element("span", "bilingual-zh", zh));
    wrap.appendChild(element("span", "bilingual-en", en));
    parent.appendChild(wrap);
    return wrap;
  }

  function cardHeading(card, id, zh, en) {
    const heading = element("h2", "overview-card-title");
    heading.id = id;
    addBilingual(heading, zh, en);
    card.appendChild(heading);
  }

  function addStatus(card, value) {
    const status = element("div", "overview-status", statusText(value));
    status.dataset.state = typeof value === "string" ? value : "unknown";
    card.appendChild(status);
    return status;
  }

  function addRow(card, zh, en, value, mono = false) {
    const row = element("div", "overview-row");
    addBilingual(row, zh, en, "span");
    const text = element("span", mono ? "overview-value mono" : "overview-value", safeValue(value));
    row.appendChild(text);
    card.appendChild(row);
  }

  function addNote(card, zh, en) {
    const note = element("p", "overview-note");
    addBilingual(note, zh, en);
    card.appendChild(note);
  }

  function addProjectLink(card, label = "去项目页 / Open Project") {
    const button = element("button", "overview-link", label);
    button.type = "button";
    button.addEventListener("click", () => {
      if (typeof switchView === "function") switchView("project");
    });
    card.appendChild(button);
  }

  function renderProject(project) {
    const card = byId("overview-project-card");
    clear(card);
    cardHeading(card, "overview-project-title", "当前项目", "Project");
    if (!project?.selected || !project.active) {
      addStatus(card, "unavailable");
      addNote(card, "尚未选择活动项目", "No active project");
      addProjectLink(card);
      return;
    }
    const activeProject = project.active;
    addStatus(card, activeProject.stale ? "stale" : "ready");
    addRow(card, "项目目录", "Repository", activeProject.repoRoot, true);
    addRow(card, "分支", "Branch", activeProject.inspection?.branch, true);
    addRow(card, "HEAD", "HEAD", activeProject.inspection?.headCommit?.hash, true);
    const counts = activeProject.inspection?.counts || {};
    addRow(card, "改动计数", "Changes", `暂存 ${counts.staged || 0} · 未暂存 ${counts.unstaged || 0} · 未跟踪 ${counts.untracked || 0} · 冲突 ${counts.conflicted || 0}`);
    if (activeProject.stale) addNote(card, "项目路径已失效，请重新识别", "Project is stale; re-identify it");
    const handoffState = activeProject.handoff?.state || "not_enabled";
    addRow(card, "AI 交接", "AI Handoff", statusText(handoffState));
    addProjectLink(card);
  }

  function renderTask(execution) {
    const card = byId("overview-task-card");
    clear(card);
    cardHeading(card, "overview-task-title", "当前任务", "Task");
    addStatus(card, execution?.available ? execution.state : "idle");
    if (!execution?.available) {
      addNote(card, "当前没有运行中的任务", "No active task");
      addProjectLink(card);
      return;
    }
    addRow(card, "任务标识", "Task ID", execution.taskId, true);
    addRow(card, "运行标识", "Run ID", execution.runId, true);
    addRow(card, "开始时间", "Started", execution.startedAt, true);
    addRow(card, "运行时长", "Duration", execution.durationMs === null ? "—" : `${execution.durationMs} ms`);
    if (execution.lastError?.code) addRow(card, "错误代码", "Error code", execution.lastError.code, true);
    addProjectLink(card);
  }

  function renderSnapshot(card, label, snapshot) {
    if (!snapshot) {
      addRow(card, label, label, "—");
      return;
    }
    const count = Number.isInteger(snapshot.changedCount) ? snapshot.changedCount : 0;
    addRow(card, label, label, `${safeValue(snapshot.branch)} · ${safeValue(snapshot.head)} · ${safeValue(snapshot.worktree)} · ${count} 项变化`);
  }

  function renderEvidence(evidence) {
    const card = byId("overview-evidence-card");
    clear(card);
    cardHeading(card, "overview-evidence-title", "证据与验收", "Evidence");
    if (!evidence?.available) {
      addStatus(card, "unavailable");
      addNote(card, "暂无可验收任务证据", "No evidence is available");
      renderRecovery(card, evidence.recovery);
      addProjectLink(card);
      return;
    }
    addStatus(card, evidence.acceptanceStatus || "pending");
    addRow(card, "执行", "Execution", statusText(evidence.evidence?.execution || evidence.executionStatus));
    addRow(card, "Git 证据", "Git Evidence", statusText(evidence.evidence?.git));
    addRow(card, "验证", "Validation", statusText(evidence.evidence?.validation));
    addRow(card, "验收", "Acceptance", statusText(evidence.acceptanceStatus));
    renderSnapshot(card, "开始快照 / Before", evidence.before);
    renderSnapshot(card, "结束快照 / After", evidence.after);
    const git = evidence.gitEvidence;
    if (git) addRow(card, "文件变化", "File changes", `新增 ${git.newCount || 0} · 修改 ${git.changedCount || 0} · 既有 ${git.preexistingCount || 0}`);
    renderRecovery(card, evidence.recovery);
    addProjectLink(card);
  }

  function renderRecovery(card, recovery) {
    if (!recovery || (!recovery.available && !["busy", "stale", "unknown"].includes(recovery.state))) return;
    const state = recovery.available ? "previewable" : recovery.state;
    addStatus(card, state);
    if (recovery.available) {
      addRow(card, "恢复来源", "Recovery Source", recovery.sourceTaskId, true);
      addRow(card, "失败原因", "Reason", recovery.reasonCode, true);
      addNote(card, "可恢复：将以新 Pi 批次继续，项目文件不会自动回退。", "Recoverable: a new Pi run will start; Files are not rolled back.");
      addProjectLink(card, "去项目页恢复 / Open Project to Recover");
    } else if (recovery.state === "busy") {
      addNote(card, "已有 Pi 任务运行，暂不能恢复。", "A Pi task is running; recovery is unavailable.");
    } else if (recovery.state === "stale") {
      addNote(card, "活动项目已失效，请重新选择项目。", "The active project is stale; select it again.");
    } else {
      addNote(card, "当前没有可安全恢复的任务。", "No task is safely recoverable right now.");
    }
  }

  function renderHandoff(overview) {
    const card = byId("overview-handoff-card");
    clear(card);
    cardHeading(card, "overview-handoff-title", "AI 交接与下一步", "AI Handoff");
    const handoff = overview?.project?.active?.handoff;
    addStatus(card, handoff?.state || "not_enabled");
    addRow(card, "当前文件", "Current file", handoff?.currentPath, true);
    addRow(card, "历史记录", "History", handoff?.recordsPath, true);
    const next = overview?.nextAction;
    if (next?.state === "ready" && next.text) {
      addRow(card, "唯一下一步", "Next Action", next.text);
    } else {
      addNote(card, "交接文件不可用，不能把缺失当作成功", "Handoff is unavailable; nothing is marked successful");
    }
    addProjectLink(card);
  }

  function render(overview) {
    renderProject(overview?.project);
    renderTask(overview?.execution);
    renderEvidence(overview?.evidence);
    renderHandoff(overview);
  }

  function setRefresh(zh, en) {
    const node = byId("overview-refresh-state");
    if (!node) return;
    clear(node);
    addBilingual(node, zh, en);
  }

  function showError(message) {
    const node = byId("overview-error");
    if (!node) return;
    node.hidden = !message;
    clear(node);
    if (message) addBilingual(node, message, "Unavailable");
  }

  async function loadOverview() {
    if (!active || !window.OPS || typeof window.OPS.api !== "function") return;
    const serial = ++requestSerial;
    if (controller) controller.abort();
    controller = new AbortController();
    setRefresh("正在刷新", "Refreshing");
    try {
      const response = await window.OPS.api("/api/overview", { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || !payload?.ok || !payload.overview) throw new Error("overview_unavailable");
      if (!active || serial !== requestSerial) return;
      lastOverview = payload.overview;
      render(lastOverview);
      showError("");
      setRefresh("已更新", "Updated");
    } catch (error) {
      if (error?.name === "AbortError" || !active || serial !== requestSerial) return;
      if (lastOverview) render(lastOverview);
      else render({ project: { selected: false }, execution: { available: false }, evidence: { available: false }, nextAction: { state: "unavailable" } });
      showError("总览暂时不可用，请稍后重试");
      setRefresh("暂不可用", "Unavailable");
    }
  }

  function activate() {
    if (active) return;
    active = true;
    loadOverview();
    timer = setInterval(loadOverview, 5000);
  }

  function deactivate() {
    active = false;
    requestSerial += 1;
    if (controller) controller.abort();
    controller = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  window.Overview = Object.freeze({ activate, deactivate, loadOverview });
})();
