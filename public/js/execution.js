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
    error: null,           // { message, action }
    riskConfirmed: false,  // 启动前的显式风险确认
    liveOutput: "",        // 运行中实时累积的输出
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
      const [projectPayload, executionPayload] = await Promise.all([
        request("/api/project/status"),
        request("/api/project/execution/status"),
      ]);
      state.active = findActiveProject(projectPayload);
      state.execution = executionPayload.execution || { state: "idle" };
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
      render();
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

  function button(className, text, onClick, { disabled = false } = {}) {
    const node = el("button", className, text);
    node.type = "button";
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  function appendOutput(text) {
    const out = panel.querySelector(".exec-output");
    if (!out) return;
    out.textContent += text;
    if (out.textContent.length > OUTPUT_DISPLAY_CAP) {
      out.textContent = out.textContent.slice(-OUTPUT_DISPLAY_CAP);
    }
    out.scrollTop = out.scrollHeight;
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
      root.appendChild(el("p", "exec-note", "正在读取运行状态…"));
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
    head.appendChild(el("h3", "exec-title", "Pi 受控运行"));
    head.appendChild(el("span", `exec-status-light ${state.execution.state || "idle"}`));
    return head;
  }

  function renderNoActive() {
    const box = el("section", "exec-card");
    box.appendChild(el("p", "exec-note", "尚未设置活动项目。请先在上方项目列表中录入并「设为活动」一个 Git 项目，Pi 将只在该目录内运行。"));
    return box;
  }

  function renderBoundary() {
    const box = el("section", "exec-card");
    box.appendChild(el("p", "exec-boundary", `工作边界：${state.active.repoRoot}`));
    box.appendChild(el("p", "exec-risk", "风险提示：Pi 在该目录内拥有你的完整用户权限，无沙箱隔离；不会向目录外主动写入，但执行破坏性命令（如删除文件）前请务必确认任务内容。"));
    return box;
  }

  function renderErrorCard() {
    const card = el("section", "exec-card error");
    card.appendChild(el("p", "exec-error-message", state.error.message));
    card.appendChild(el("p", "exec-error-action", `建议：${state.error.action}`));
    card.appendChild(button("exec-btn", "知道了", () => {
      state.error = null;
      render();
    }));
    return card;
  }

  function renderRunning() {
    const box = el("section", "exec-card");
    const stopping = state.execution.state === "stopping";
    box.appendChild(el("p", "exec-note", stopping ? "正在停止…" : "Pi 正在执行，可随时停止。"));
    if (state.execution.task) box.appendChild(el("p", "exec-task-line", `任务：${state.execution.task}`));

    // 已运行时长：让用户明确看到任务在跑、停止是有效操作
    const elapsed = el("p", "exec-elapsed", "已运行 0 秒");
    box.appendChild(elapsed);
    startElapsedTicker(elapsed);

    const out = el("pre", "exec-output", state.liveOutput || state.execution.output || "");
    box.appendChild(out);

    const actions = el("div", "exec-actions");
    actions.appendChild(button("exec-btn danger", state.busy ? "停止中…" : "停止", () => stopRun(), { disabled: state.busy || stopping }));
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
      if (target.isConnected) target.textContent = `已运行 ${secs} 秒`;
      if (state.execution.state === "running" || state.execution.state === "stopping") {
        elapsedTimer = setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function renderIdleForm(exState) {
    const box = el("section", "exec-card");

    if (exState === "exited" || exState === "stopped" || exState === "error") {
      const summary = el("p", "exec-note");
      if (exState === "exited") summary.textContent = `上一次运行已结束（退出码 ${state.execution.exitCode ?? "—"}）。`;
      else if (exState === "stopped") summary.textContent = "上一次运行已被手动停止。";
      else summary.textContent = "上一次运行异常结束。";
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
      actions.appendChild(button("exec-btn danger", "确认启动？再点一次", () => {
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
      actions.appendChild(button("exec-btn primary", state.busy ? "启动中…" : "启动 Pi", () => {
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
    actions.appendChild(button("exec-btn", "刷新状态", () => refreshExecution(), { disabled: state.busy }));
    box.appendChild(actions);
    return box;
  }

  // ── 轮询与生命周期 ──

  function startPolling() {
    clearTimeout(pollTimer);
    // 非流式状态下低频拉取服务端状态，保证与服务端一致
    if (!state.streaming) {
      pollTimer = setTimeout(() => { refreshExecution(); }, 5000);
    }
  }

  loadAll();
})();
