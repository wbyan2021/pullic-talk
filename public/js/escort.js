"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const elements = {
    panel: byId("escort-panel"),
    toggle: byId("escort-toggle"),
    close: byId("escort-close"),
    scrim: byId("escort-scrim"),
    topLabel: byId("escort-top-label"),
    statusLabel: byId("escort-status-label"),
    statusMessage: byId("escort-status-message"),
    statusAction: byId("escort-status-action"),
    inlineError: byId("escort-inline-error"),
    keySetup: byId("escort-key-setup"),
    keySaved: byId("escort-key-saved"),
    keyForm: byId("escort-key-form"),
    keyInput: byId("escort-key-input"),
    saveKey: byId("escort-save-key"),
    maskedKey: byId("escort-masked-key"),
    retry: byId("escort-retry"),
    replace: byId("escort-replace"),
    deleteKey: byId("escort-delete"),
    chat: byId("escort-chat"),
    messages: byId("escort-messages"),
    chatForm: byId("escort-chat-form"),
    messageInput: byId("escort-message-input"),
    send: byId("escort-send"),
  };

  if (!elements.panel || !window.OPS) return;

  const LABELS = {
    unconfigured: ["未接入能源", "未配置"],
    unchecked: ["等待连接检测", "待检测"],
    checking: ["正在检查连接", "检测中"],
    available: ["护航在线", "在线"],
    limited: ["能源当前受限", "受限"],
    unavailable: ["护航暂时离线", "异常"],
  };

  const DEFAULT_MESSAGES = {
    unconfigured: "接入 DeepSeek 后，护航 AI 可以独立于 Pi 提供配置和诊断帮助。",
    unchecked: "凭据已安全保存，需要进行一次真实连接检测。",
    checking: "正在向 DeepSeek 发起最小检测请求，请稍候。",
    available: "DeepSeek 连接正常。不会配置或看不懂状态时，直接在下面提问。",
    limited: "凭据存在，但余额或请求限制暂时阻止调用。",
    unavailable: "凭据、网络或服务存在问题，请按建议处理后重试。",
  };

  let status = null;
  let busy = false;
  let replacing = false;
  let history = [];

  function openPanel() {
    if (window.matchMedia("(max-width: 1180px)").matches) document.body.classList.add("escort-open");
    elements.toggle.setAttribute("aria-expanded", "true");
    elements.panel.focus?.({ preventScroll: true });
  }

  function closePanel() {
    document.body.classList.remove("escort-open");
    elements.toggle.setAttribute("aria-expanded", "false");
  }

  function setInlineError(message, action) {
    const text = [message, action].filter(Boolean).join(" 建议：");
    elements.inlineError.textContent = text;
    elements.inlineError.hidden = !text;
  }

  function clearInlineError() {
    elements.inlineError.textContent = "";
    elements.inlineError.hidden = true;
  }

  function availability() {
    return status?.availability || "checking";
  }

  function renderMessages() {
    elements.messages.replaceChildren();
    for (const item of history) {
      const node = document.createElement("div");
      node.className = `escort-message ${item.role}`;
      node.textContent = item.content;
      elements.messages.appendChild(node);
    }
    elements.messages.scrollTop = elements.messages.scrollHeight;
  }

  function render() {
    const current = availability();
    const labels = LABELS[current] || LABELS.unavailable;
    const configured = Boolean(status?.configured);
    document.body.dataset.escortAvailability = current;
    elements.panel.dataset.availability = current;
    elements.statusLabel.textContent = labels[0];
    elements.topLabel.textContent = labels[1];
    elements.statusMessage.textContent = status?.error?.message || DEFAULT_MESSAGES[current];
    elements.statusAction.textContent = status?.error?.action ? `下一步：${status.error.action}` : "";

    elements.keySetup.hidden = configured && !replacing;
    elements.keySaved.hidden = !configured;
    elements.chat.hidden = current !== "available";
    if (configured) elements.maskedKey.textContent = status.display || "••••••••（已安全保存）";

    for (const control of [elements.keyInput, elements.saveKey, elements.retry, elements.replace, elements.deleteKey, elements.messageInput, elements.send]) {
      control.disabled = busy;
    }
    elements.retry.hidden = !configured;
    renderMessages();
  }

  async function requestJson(url, options) {
    const response = await window.OPS.api(url, options);
    let payload;
    try { payload = await response.json(); }
    catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.message || "请求失败，请稍后重试。");
      error.action = payload.action || "重新加载页面";
      error.code = payload.code || "request_failed";
      throw error;
    }
    return payload;
  }

  async function runBusy(operation) {
    if (busy) return;
    busy = true;
    clearInlineError();
    render();
    try {
      await operation();
    } catch (error) {
      setInlineError(error.message || "请求失败，请稍后重试。", error.action);
    } finally {
      busy = false;
      render();
    }
  }

  async function loadStatus() {
    await runBusy(async () => {
      const payload = await requestJson("/api/providers/deepseek/status");
      status = payload.status;
    });
  }

  async function checkConnection() {
    status = { ...(status || {}), configured: true, availability: "checking", error: null };
    render();
    const payload = await requestJson("/api/providers/deepseek/check", { method: "POST" });
    status = payload.status;
  }

  elements.keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const apiKey = elements.keyInput.value;
    runBusy(async () => {
      const saved = await requestJson("/api/providers/deepseek/credential", {
        method: "PUT",
        json: { apiKey },
      });
      elements.keyInput.value = "";
      status = saved.status;
      replacing = false;
      await checkConnection();
    });
  });

  elements.retry.addEventListener("click", () => runBusy(checkConnection));

  elements.replace.addEventListener("click", () => {
    replacing = true;
    elements.keyInput.value = "";
    clearInlineError();
    render();
    elements.keyInput.focus();
  });

  elements.deleteKey.addEventListener("click", () => {
    if (!window.confirm("删除 DeepSeek API Key？删除后护航 AI 将离线，但不会影响你的项目文件。")) return;
    runBusy(async () => {
      const payload = await requestJson("/api/providers/deepseek/credential", { method: "DELETE" });
      status = payload.status;
      replacing = false;
      history = [];
    });
  });

  elements.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = elements.messageInput.value.trim();
    if (!message) return;
    const requestHistory = history.slice(-12).map((item) => ({ role: item.role, content: item.content }));
    history.push({ role: "user", content: message });
    history = history.slice(-12);
    elements.messageInput.value = "";
    renderMessages();
    runBusy(async () => {
      const payload = await requestJson("/api/escort/messages", {
        method: "POST",
        json: { message, history: requestHistory },
      });
      history.push({ role: "assistant", content: payload.reply.text });
      history = history.slice(-12);
      status = payload.status;
    });
  });

  elements.toggle.addEventListener("click", () => {
    if (document.body.classList.contains("escort-open")) closePanel();
    else openPanel();
  });
  elements.close.addEventListener("click", closePanel);
  elements.scrim.addEventListener("click", closePanel);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("escort-open")) closePanel();
  });

  if (window.matchMedia("(max-width: 1180px)").matches) closePanel();
  render();
  loadStatus();
})();
