"use strict";
/* ═══════════════════════════════════════════
   AI·OPS COCKPIT — 项目 view · Pi 受控运行面板（S03）
   - 在活动（ACTIVE）项目内启动 Pi，流式观察输出，可随时停止
   - 启动前必须显式确认风险（riskConfirmed）
   - 安全：所有动态内容使用 createElement/textContent，不做 HTML 字符串注入
   - SSE 通过 fetch + body.getReader() + TextDecoder 消费（可携带认证头，不用浏览器原生事件源 API）
   - 数据：一切以服务端为准，浏览器不做任何持久化
   ═══════════════════════════════════════════ */
(() => {
  const panel = document.getElementById("execution-panel");
  if (!panel) return;

  const OUTPUT_DISPLAY_CAP = 256 * 1024; // 显示上限，超出只保留尾部

  const state = {
    loading: false,
    busy: false,
    streaming: false,
    active: null,          // 活动项目 payload（来自 /api/project/status）
    execution: { state: "idle", runId: null, output: "", task: null },
    evidence: { state: "idle", acceptanceStatus: "pending", validation: { result: "not_run" } },
    recovery: { available: false, sourceTaskId: null, sourceState: null, reasonCode: null, state: "not_available" },
    recoveryPreview: null,
    recoveryConfirm: false,
    recoveryBusy: false,
    error: null,           // { message, action }
    riskConfirmed: false,  // 启动前的显式风险确认
    liveOutput: "",        // 运行中实时累积的输出
    validationBusy: false,
    validationConfirm: false,
    acceptanceConfirm: false,
  };
  let confirmTimer = null;
  let pollTimer = null;
  let elapsedTimer = null; // 运行态每秒刷新已运行时长
  let streamAbort = null;
  let draftTask = ""; // 跨渲染保留用户已输入的任务文本

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

  async function loadAll() {
    state.loading = true;
    state.error = null;
    render();
    try {
      const [projectPayload, executionPayload, evidencePayload, recoveryPayload] = await Promise.all([
        request("/api/project/status"),
        request("/api/project/execution/status"),
        request("/api/evidence/status"),
        request("/api/recovery/status").catch(() => ({ recovery: { available: false, state: "not_available" } })),
      ]);
      const nextActive = findActiveProject(projectPayload);
      if (state.active?.id !== nextActive?.id) {
        state.recoveryPreview = null;
        state.recoveryConfirm = false;
      }
      state.active = nextActive;
      state.execution = executionPayload.execution || { state: "idle" };
      state.evidence = evidencePayload.evidence || { state: "idle", acceptanceStatus: "pending", validation: { result: "not_run" } };
      state.recovery = recoveryPayload.recovery || { available: false, state: "not_available" };
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function findActiveProject(projectPayload) {
    // 状态接口返回 { projects, activeProjectId }；活动项目从列表中推导（D8）
    if (!projectPayload || !projectPayload.activeProjectId) return null;
    const list = Array.isArray(projectPayload.projects) ? projectPayload.projects : [];
    return list.find((p) => p.id === projectPayload.activeProjectId) || null;
  }

  function pickError(error) {
    return {
      message: error.message || "请求失败，请稍后重试。",
      action: error.action || "重新加载页面",
    };
  }

  // ── SSE 启动与消费 ──

  async function startRun(task) {
    if (state.busy || state.streaming) return;
    state.busy = true;
    state.error = null;
    state.liveOutput = "";
    render();
    streamAbort = new AbortController();
    let response;
    try {
      response = await window.OPS.api("/api/project/execution/start", {
        method: "POST",
        json: { task },
        signal: streamAbort.signal,
      });
    } catch (error) {
      draftTask = task; // 启动失败时保留任务文本
      state.busy = false;
      state.error = pickError(error);
      render();
      return;
    }
    const contentType = response.headers.get("Content-Type") || "";
    if (!response.ok || !contentType.includes("text/event-stream")) {
      let payload = {};
      try { payload = await response.json(); } catch { /* 非 JSON */ }
      draftTask = task; // 启动失败时保留任务文本
      state.busy = false;
      state.error = {
        message: payload.message || "启动失败，请稍后重试。",
        action: payload.action || "重新加载页面",
      };
      render();
      return;
    }

    state.streaming = true;
    state.execution.state = "running";
    state.busy = false;
    render();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          handleSseBlock(block);
        }
      }
    } catch (error) {
      if (error && error.name !== "AbortError") {
        state.error = pickError(error);
      }
    } finally {
      state.streaming = false;
      // 流结束后以服务端状态为准
      await refreshExecution();
    }
  }

  function handleSseBlock(block) {
    let eventType = "message";
    let dataText = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      else if (line.startsWith("data:")) dataText += line.slice(5).trim();
    }
    if (!dataText) return;
    let data;
    try { data = JSON.parse(dataText); } catch { return; }

    if (eventType === "chunk" && typeof data.text === "string") {
      state.liveOutput += data.text;
      if (state.liveOutput.length > OUTPUT_DISPLAY_CAP) {
        state.liveOutput = state.liveOutput.slice(-OUTPUT_DISPLAY_CAP);
      }
      appendOutput(data.text);
    } else if (eventType === "done") {
      state.execution.state = data.state || "exited";
      state.execution.exitCode = data.exitCode ?? null;
      state.execution.truncated = Boolean(data.truncated);
      // The server closes the SSE after done; release the running view immediately
      // so a stopped task can be continued without waiting for a second poll.
      state.streaming = false;
      render();
      refreshEvidence();
    } else if (eventType === "status") {
      if (data.state) state.execution.state = data.state;
      render();
    }
  }

  async function stopRun() {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      const payload = await request("/api/project/execution/stop", { method: "POST" });
      state.execution = payload.execution || state.execution;
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function refreshExecution() {
    let next;
    try {
      const payload = await request("/api/project/execution/status");
      next = payload.execution || state.execution;
    } catch { return; /* 保持旧状态，不重渲染 */ }
    // 只有状态真的变化才重渲染，避免轮询周期性销毁用户正在输入的输入框
    if (executionSnapshot(next) === executionSnapshot(state.execution)) return;
    state.execution = next;
    render();
    await refreshEvidence();
  }

  async function refreshEvidence() {
    try {
      const payload = await request("/api/evidence/status");
      state.evidence = payload.evidence || state.evidence;
      render();
    } catch { /* 保持当前证据摘要，不覆盖执行状态 */ }
    await refreshRecovery();
  }

  async function refreshRecovery() {
    try {
      const payload = await request("/api/recovery/status");
      state.recovery = payload.recovery || { available: false, state: "not_available" };
      if (!state.recovery.available) {
        state.recoveryPreview = null;
        state.recoveryConfirm = false;
      }
      render();
    } catch {
      state.recovery = { available: false, state: "not_available" };
      state.recoveryPreview = null;
      state.recoveryConfirm = false;
    }
  }

  async function previewRecovery() {
    if (state.recoveryBusy || !state.recovery?.available || !state.recovery.sourceTaskId) return;
    state.recoveryBusy = true;
    state.error = null;
    render();
    try {
      const taskId = encodeURIComponent(state.recovery.sourceTaskId);
      const payload = await request(`/api/recovery/${taskId}/preview`);
      state.recoveryPreview = payload.recovery || null;
      state.recoveryConfirm = false;
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.recoveryBusy = false;
      render();
    }
  }

  function cancelRecovery() {
    state.recoveryPreview = null;
    state.recoveryConfirm = false;
    state.error = null;
    render();
  }

  async function startRecovery() {
    const preview = state.recoveryPreview;
    if (state.recoveryBusy || !preview?.previewId || !state.recovery.sourceTaskId) return;
    if (!state.recoveryConfirm) {
      state.recoveryConfirm = true;
      render();
      return;
    }
    state.recoveryBusy = true;
    state.error = null;
    render();
    try {
      const taskId = encodeURIComponent(state.recovery.sourceTaskId);
      await request(`/api/recovery/${taskId}/start`, {
        method: "POST",
        json: { previewId: preview.previewId, confirmed: true },
      });
      state.recoveryPreview = null;
      state.recoveryConfirm = false;
      await loadAll();
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.recoveryBusy = false;
      render();
    }
  }

  function parseValidationDraft() {
    const executable = panel.querySelector(".exec-validation-executable")?.value.trim() || "";
    const argsText = panel.querySelector(".exec-validation-args")?.value.trim() || "";
    const args = argsText ? argsText.split(/\s+/).filter(Boolean) : [];
    return { executable, args, cwd: state.active?.repoRoot, approvedByUser: false };
  }

  async function previewValidation() {
    if (state.validationBusy) return;
    const command = parseValidationDraft();
    state.validationBusy = true;
    state.error = null;
    try {
      await request("/api/evidence/validation/preview", { method: "POST", json: command });
      state.validationConfirm = true;
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.validationBusy = false;
      render();
    }
  }

  async function runValidation() {
    if (state.validationBusy) return;
    const command = parseValidationDraft();
    command.approvedByUser = true;
    state.validationBusy = true;
    state.error = null;
    try {
      await request("/api/evidence/validation/run", { method: "POST", json: command });
      state.validationConfirm = false;
      await refreshEvidence();
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.validationBusy = false;
      render();
    }
  }

  async function closeEvidence(acceptanceStatus) {
    if (state.busy) return;
    if (acceptanceStatus === "accepted" && !state.acceptanceConfirm) {
      state.acceptanceConfirm = true;
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    try {
      await request("/api/evidence/close", {
        method: "POST",
        json: { acceptanceStatus, userConfirmed: acceptanceStatus === "accepted" },
      });
      state.acceptanceConfirm = false;
      await refreshEvidence();
    } catch (error) {
      state.error = pickError(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  function executionSnapshot(ex) {
    if (!ex) return "";
    return [ex.state, ex.runId, ex.exitCode, ex.truncated, ex.durationMs, ex.output, ex.task].join("\u0001");
  }

  // ── DOM 构建（仅使用安全 API） ──

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // 机器状态保留在英文辅助标签中，中文是用户首先看到的解释。
  const STATUS_LABELS = Object.freeze({
    idle: ["空闲", "Idle"],
    creating: ["准备中", "Creating"],
    running: ["执行中", "Running"],
    stopping: ["停止中", "Stopping"],
    stopped: ["已停止", "Stopped"],
    failed: ["失败", "Failed"],
    error: ["失败", "Failed"],
    exited: ["已结束", "Completed"],
    done: ["已结束", "Completed"],
    interrupted: ["已中断", "Interrupted"],
    unknown: ["未知", "Unknown"],
    pending: ["待处理", "Pending"],
    not_run: ["未运行", "Not Run"],
    passed: ["通过", "Passed"],
    needs_review: ["需要复核", "Needs Review"],
    accepted: ["验收通过", "Accepted"],
    rejected: ["已拒绝", "Rejected"],
    verified: ["已验证", "Verified"],
    previewable: ["可恢复", "Recoverable"],
    busy: ["已有任务运行", "Busy"],
    stale: ["项目已失效", "Stale"],
  });

  function bilingual(zh, en) {
    const node = el("span", "bilingual");
    node.appendChild(el("span", "bilingual-zh", zh));
    node.appendChild(el("span", "bilingual-en", en));
    return node;
  }

  function bilingualElement(tag, className, zh, en) {
    const node = el(tag, className);
    node.appendChild(bilingual(zh, en));
    return node;
  }

  function statusPair(value, fallback = "unknown") {
    const raw = String(value || fallback);
    return STATUS_LABELS[raw.toLowerCase()] || [STATUS_LABELS.unknown[0], raw || "Unknown"];
  }

  function statusNode(value, fallback = "unknown") {
    const [zh, en] = statusPair(value, fallback);
    return bilingual(zh, en);
  }

  function appendContent(node, content) {
    if (content && typeof content === "object" && content.nodeType) node.appendChild(content);
    else node.textContent = content == null ? "" : String(content);
  }

  function appendInlinePair(parent, zh, en, value) {
    parent.appendChild(bilingual(zh, en));
    parent.appendChild(document.createTextNode(": "));
    appendContent(parent, value);
  }

  function appendGitSnapshot(parent, zh, en, snapshot) {
    appendInlinePair(parent, zh, en, snapshot?.branch && snapshot.branch !== "unknown"
      ? snapshot.branch
      : statusNode("unknown"));
    parent.appendChild(document.createTextNode(" · "));
    appendContent(parent, snapshot?.head || "—");
  }

  function button(className, text, onClick, { disabled = false } = {}) {
    const node = el("button", className);
    appendContent(node, text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  function appendOutput(text) {
    const out = panel.querySelector(".exec-output");
    if (!out) return;
    // 只在用户本就贴近底部时自动滚动，避免输出流把用户强行拽离正在阅读的位置
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent += text;
    if (out.textContent.length > OUTPUT_DISPLAY_CAP) {
      out.textContent = out.textContent.slice(-OUTPUT_DISPLAY_CAP);
    }
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  function render() {
    // 重建前记住输入框的焦点与光标，重建后恢复，避免打断用户输入
    const prevTask = panel.querySelector(".exec-task");
    const hadFocus = prevTask && document.activeElement === prevTask;
    const selStart = hadFocus ? prevTask.selectionStart : 0;
    const selEnd = hadFocus ? prevTask.selectionEnd : 0;

    panel.textContent = "";
    const root = el("div", "exec-root");

    root.appendChild(renderHead());

    if (state.loading) {
      root.appendChild(bilingualElement("p", "exec-note", "正在读取运行状态…", "Loading execution status…"));
      panel.appendChild(root);
      return;
    }

    if (state.error) root.appendChild(renderErrorCard());

    if (!state.active) {
      root.appendChild(renderNoActive());
      panel.appendChild(root);
      return;
    }

    root.appendChild(renderBoundary());
    root.appendChild(renderEvidence());

    const exState = state.execution.state || "idle";
    if (exState === "running" || exState === "stopping" || state.streaming) {
      root.appendChild(renderRunning());
    } else {
      root.appendChild(renderIdleForm(exState));
    }

    panel.appendChild(root);
    // 恢复输入焦点与光标（若重建前用户正在输入）
    if (hadFocus) {
      const nextTask = panel.querySelector(".exec-task");
      if (nextTask) {
        nextTask.focus({ preventScroll: true });
        try { nextTask.setSelectionRange(selStart, selEnd); } catch { /* 忽略 */ }
      }
    }
    startPolling();
  }

  function renderHead() {
    const head = el("div", "exec-head");
    head.appendChild(bilingualElement("h3", "exec-title", "Pi 受控运行", "Pi Controlled Run"));
    head.appendChild(el("span", `exec-status-light ${state.execution.state || "idle"}`));
    return head;
  }

  function renderNoActive() {
    const box = el("section", "exec-card");
    box.appendChild(bilingualElement("p", "exec-note", "尚未设置活动项目。请先在上方项目列表中录入并「设为活动」一个 Git 项目，Pi 将只在该目录内运行。", "No active project. Add and set a Git project active above; Pi runs only in that directory."));
    return box;
  }

  function renderBoundary() {
    const box = el("section", "exec-card");
    const boundary = el("p", "exec-boundary");
    appendInlinePair(boundary, "工作边界", "Work Boundary", state.active.repoRoot);
    box.appendChild(boundary);
    box.appendChild(bilingualElement("p", "exec-risk", "风险提示：Pi 在该目录内拥有你的完整用户权限，无沙箱隔离；不会向目录外主动写入，但执行破坏性命令（如删除文件）前请务必确认任务内容。", "Risk: Pi has your full user permissions in this directory without a sandbox. Confirm destructive tasks before running them."));
    return box;
  }

  function renderEvidence() {
    const box = el("section", "exec-card exec-evidence");
    box.appendChild(bilingualElement("h4", "exec-evidence-title", "任务时间线与验收", "Task Timeline & Acceptance"));
    const evidence = state.evidence || {};
    const summary = el("p", "exec-note");
    appendInlinePair(summary, "执行", "Execution", statusNode(evidence.executionStatus || evidence.state || "idle"));
    summary.appendChild(document.createTextNode(" · "));
    appendInlinePair(summary, "Git 证据", "Git Evidence", statusNode(evidence.evidence?.git || "unknown"));
    summary.appendChild(document.createTextNode(" · "));
    appendInlinePair(summary, "验收", "Acceptance", statusNode(evidence.acceptanceStatus || "pending"));
    box.appendChild(summary);
    if (evidence.before || evidence.after) {
      const timeline = el("div", "exec-timeline");
      const before = el("div", "exec-timeline-item");
      appendGitSnapshot(before, "开始前", "Before", evidence.before);
      timeline.appendChild(before);
      const after = el("div", "exec-timeline-item");
      appendGitSnapshot(after, "结束后", "After", evidence.after);
      timeline.appendChild(after);
      const validation = el("div", "exec-timeline-item");
      appendInlinePair(validation, "验证", "Validation", statusNode(evidence.validation?.result || "not_run"));
      timeline.appendChild(validation);
      box.appendChild(timeline);
    }
    const terminal = ["exited", "stopped", "failed", "interrupted"].includes(evidence.executionStatus || evidence.state);
    if (terminal && evidence.acceptanceStatus === "pending") {
      const validation = el("div", "exec-validation");
      validation.appendChild(bilingualElement("p", "exec-note", "验收命令使用程序 + 参数模型运行，不接受 shell 命令字符串。", "Validation uses an executable + argument model; shell command strings are not accepted."));
      const executable = document.createElement("input");
      executable.className = "exec-validation-executable";
      executable.placeholder = "程序 Executable，例如 npm";
      const args = document.createElement("input");
      args.className = "exec-validation-args";
      args.placeholder = "参数 Arguments，例如 test";
      validation.appendChild(executable);
      validation.appendChild(args);
      validation.appendChild(button("exec-btn primary", state.validationConfirm
        ? bilingual("确认执行验收", "Confirm Validation")
        : bilingual("预览验收命令", "Preview Validation Command"), () => {
        if (state.validationConfirm) runValidation();
        else previewValidation();
      }, { disabled: state.validationBusy }));
      box.appendChild(validation);
      const actions = el("div", "exec-actions");
      actions.appendChild(button("exec-btn", state.acceptanceConfirm
        ? bilingual("确认验收通过", "Confirm Accepted")
        : bilingual("标记验收通过", "Mark Accepted"), () => closeEvidence("accepted"), { disabled: state.busy || evidence.validation?.result !== "passed" }));
      actions.appendChild(button("exec-btn", bilingual("标记需要复核", "Mark Needs Review"), () => closeEvidence("needs_review"), { disabled: state.busy }));
      actions.appendChild(button("exec-btn danger-outline", bilingual("标记已拒绝", "Mark Rejected"), () => closeEvidence("rejected"), { disabled: state.busy }));
      box.appendChild(actions);
    } else if (evidence.acceptanceStatus && evidence.acceptanceStatus !== "pending") {
      const result = el("p", "exec-note");
      appendInlinePair(result, "验收结果", "Acceptance Result", statusNode(evidence.acceptanceStatus));
      box.appendChild(result);
    }
    renderRecovery(box);
    return box;
  }

  function renderRecovery(box) {
    const recovery = state.recovery || {};
    if (!recovery.available && !["busy", "stale", "unknown"].includes(recovery.state)) return;
    const section = el("div", "exec-recovery");
    section.appendChild(bilingualElement("h5", "exec-recovery-title", "安全恢复", "Safe Recovery"));
    if (recovery.available) {
      section.appendChild(statusNode("previewable"));
      const source = el("p", "exec-note");
      appendInlinePair(source, "来源任务", "Source Task", recovery.sourceTaskId || "—");
      source.appendChild(document.createTextNode(" · "));
      appendInlinePair(source, "原因", "Reason", recovery.reasonCode || "unknown");
      section.appendChild(source);
      if (state.recoveryPreview) {
        const preview = state.recoveryPreview;
        const facts = el("div", "exec-recovery-facts");
        appendInlinePair(facts, "项目", "Project", preview.projectId || "—");
        facts.appendChild(document.createTextNode(" · "));
        appendInlinePair(facts, "分支", "Branch", preview.branch || "—");
        facts.appendChild(document.createTextNode(" · "));
        appendInlinePair(facts, "HEAD", "HEAD", preview.head || "—");
        facts.appendChild(document.createTextNode(" · "));
        appendInlinePair(facts, "改动", "Changes", `${preview.changedCount ?? 0}`);
        section.appendChild(facts);
        section.appendChild(bilingualElement("p", "exec-recovery-warning", "不会回退文件；恢复只会在当前活动项目中启动新的 Pi 批次。", "Files will not be rolled back; recovery starts a new Pi run in the active project."));
        if (preview.expiresAt) {
          const expires = el("p", "exec-note");
          appendInlinePair(expires, "预览有效期至", "Preview expires", preview.expiresAt);
          section.appendChild(expires);
        }
        const actions = el("div", "exec-actions");
        actions.appendChild(button("exec-btn", bilingual("取消预览", "Cancel Preview"), cancelRecovery, { disabled: state.recoveryBusy }));
        actions.appendChild(button("exec-btn primary", state.recoveryConfirm
          ? bilingual("再次确认恢复", "Confirm Recovery")
          : bilingual("确认恢复", "Review & Confirm"), startRecovery, { disabled: state.recoveryBusy }));
        section.appendChild(actions);
      } else {
        section.appendChild(button("exec-btn primary", state.recoveryBusy
          ? bilingual("正在生成预览…", "Preparing Preview…")
          : bilingual("预览恢复", "Preview Recovery"), previewRecovery, { disabled: state.recoveryBusy }));
      }
    } else if (recovery.state === "busy") {
      section.appendChild(statusNode("busy"));
      section.appendChild(bilingualElement("p", "exec-note", "已有 Pi 任务正在运行，暂不能恢复。", "A Pi task is already running; recovery is unavailable."));
    } else if (recovery.state === "stale") {
      section.appendChild(statusNode("stale"));
      section.appendChild(bilingualElement("p", "exec-note", "活动项目已失效，请重新识别或选择项目。", "The active project is stale; re-identify or select it."));
    } else {
      section.appendChild(statusNode("unknown"));
      section.appendChild(bilingualElement("p", "exec-note", "当前没有可安全恢复的任务。", "No task is safely recoverable right now."));
    }
    box.appendChild(section);
  }

  function renderErrorCard() {
    const card = el("section", "exec-card error");
    card.appendChild(bilingualElement("h4", "exec-evidence-title", "错误", "Error"));
    card.appendChild(el("p", "exec-error-message", state.error.message));
    card.appendChild(el("p", "exec-error-action", `建议：${state.error.action}`));
    card.appendChild(button("exec-btn", bilingual("知道了", "Got it"), () => {
      state.error = null;
      render();
    }));
    return card;
  }

  function renderRunning() {
    const box = el("section", "exec-card");
    const stopping = state.execution.state === "stopping";
    box.appendChild(bilingualElement("p", "exec-note", stopping ? "正在停止…" : "Pi 正在执行，可随时停止。", stopping ? "Stopping…" : "Pi is running; you can stop it anytime."));
    if (state.execution.task) {
      const taskLine = el("p", "exec-task-line");
      appendInlinePair(taskLine, "任务", "Task", state.execution.task);
      box.appendChild(taskLine);
    }

    // 已运行时长：让用户明确看到任务在跑、停止是有效操作
    const elapsed = bilingualElement("p", "exec-elapsed", "已运行 0 秒", "Elapsed: 0s");
    box.appendChild(elapsed);
    startElapsedTicker(elapsed);

    const out = el("pre", "exec-output", state.liveOutput || state.execution.output || "");
    box.appendChild(out);

    const actions = el("div", "exec-actions");
    actions.appendChild(button("exec-btn danger", state.busy
      ? bilingual("停止中…", "Stopping…")
      : bilingual("停止", "Stop"), () => stopRun(), { disabled: state.busy || stopping }));
    box.appendChild(actions);
    return box;
  }

  function startElapsedTicker(target) {
    clearTimeout(elapsedTimer);
    const startedAt = state.execution.startedAt;
    if (!startedAt) return;
    const startMs = new Date(startedAt).getTime();
    const tick = () => {
      const secs = Math.max(0, Math.round((Date.now() - startMs) / 1000));
      if (target.isConnected) {
        target.replaceChildren(bilingual(`已运行 ${secs} 秒`, `Elapsed: ${secs}s`));
      }
      if (state.execution.state === "running" || state.execution.state === "stopping") {
        elapsedTimer = setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function renderIdleForm(exState) {
    const box = el("section", "exec-card");

    if (exState === "exited" || exState === "stopped" || exState === "failed" || exState === "interrupted" || exState === "error") {
      const summary = el("p", "exec-note");
      if (exState === "exited") {
        summary.appendChild(bilingual(`上一次运行已结束（退出码 ${state.execution.exitCode ?? "—"}）。`, `Last run completed (exit code ${state.execution.exitCode ?? "—"}).`));
      } else if (exState === "stopped") {
        summary.appendChild(bilingual("上一次运行已被手动停止。", "Last run was stopped manually."));
      } else {
        summary.appendChild(bilingual("上一次运行异常结束。", "Last run ended with an error."));
      }
      box.appendChild(summary);
      if (state.execution.output) {
        const out = el("pre", "exec-output", state.execution.output);
        box.appendChild(out);
      }
    }

    const textarea = document.createElement("textarea");
    textarea.className = "exec-task";
    textarea.placeholder = "输入一条明确的任务，例如：列出当前目录的文件并说明各自用途";
    textarea.maxLength = 4000;
    textarea.rows = 3;
    textarea.value = draftTask;
    textarea.addEventListener("input", () => { draftTask = textarea.value; });
    box.appendChild(textarea);

    const actions = el("div", "exec-actions");
    if (state.riskConfirmed) {
      actions.appendChild(button("exec-btn danger", bilingual("确认启动？再点一次", "Confirm Start"), () => {
        clearTimeout(confirmTimer);
        state.riskConfirmed = false;
        const task = textarea.value.trim();
        if (!task) {
          state.error = { message: "任务内容不能为空。", action: "输入一条明确的任务" };
          render();
          return;
        }
        startRun(task);
      }));
    } else {
      actions.appendChild(button("exec-btn primary", state.busy
        ? bilingual("启动中…", "Starting…")
        : bilingual("启动 Pi", "Start Pi"), () => {
        draftTask = textarea.value;
        state.riskConfirmed = true;
        render();
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => {
          state.riskConfirmed = false;
          render();
        }, 5000);
      }, { disabled: state.busy }));
    }
    actions.appendChild(button("exec-btn", bilingual("刷新状态", "Refresh Status"), () => refreshExecution(), { disabled: state.busy }));
    box.appendChild(actions);
    return box;
  }

  // ── 轮询与生命周期 ──

  function startPolling() {
    clearTimeout(pollTimer);
    // 非流式状态下低频拉取服务端状态，保证与服务端一致；
    // refreshExecution 内部自吞错误，无论结果如何都续链，避免轮询在第一次空变化后断掉
    if (!state.streaming) {
      pollTimer = setTimeout(() => { refreshExecution().finally(startPolling); }, 5000);
    }
  }

  window.addEventListener("ops:active-project-changed", () => {
    loadAll();
  });

  loadAll();
})();
