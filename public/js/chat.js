  // ===== marked 配置 =====
  marked.setOptions({ breaks: true, gfm: true });
  // 代码块复制按钮（兼容 marked v5+ 对象参数）
  const renderer = new marked.Renderer();
  const origCode = renderer.code.bind(renderer);
  renderer.code = function(codeOrObj, lang) {
    const html = typeof codeOrObj === "object"
      ? origCode(codeOrObj)
      : origCode(codeOrObj, lang);
    return html.replace("<pre>", '<pre><button class="code-copy-btn">复制</button>');
  };
  marked.use({ renderer });

  // markdown 渲染 + XSS 消毒（DOMPurify 加载失败时降级为直接渲染）
  function renderMarkdown(text) {
    let html = marked.parse(text || "");
    if (window.DOMPurify) html = DOMPurify.sanitize(html);
    return html;
  }

  // ===== 全局状态 =====
  const AGENT_INFO = { user: { name: "你", role: "", avatar: "你" } };
  const selectedAgents = new Set();
  let history = [];
  let isStreaming = false;
  let stoppedByUser = false;
  let thinkingMode = localStorage.getItem("tri-thinking") || "medium";
  let chatMode = localStorage.getItem("tri-mode") || "parallel";
  let rounds = Number(localStorage.getItem("tri-rounds")) || 1;
  let abortController = null;
  const streamBuffers = {};
  const agentModels = {}; // 每个 agent 当前选中的模型

  const HLJS_THEMES = {
    dark: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css",
    light: "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css",
  };

  // ===== 动态渲染 agent 按钮 =====
  async function loadAgents() {
    try {
      const res = await fetch("/api/models");
      const agents = await res.json();
      const container = document.getElementById("agent-toggles");
      container.innerHTML = "";

      for (const [key, info] of Object.entries(agents)) {
        const bgColor = hexToRgba(info.color, 0.08);

        // 注册 agent 信息
        AGENT_INFO[key] = { name: info.name, role: info.role, avatar: info.avatar, model: info.model, color: info.color };
        selectedAgents.add(key);

        // 创建 toggle 按钮
        const el = document.createElement("div");
        el.className = "agent-toggle active";
        el.dataset.agent = key;
        el.onclick = () => toggleAgent(key);
        el.innerHTML = `
          <div class="agent-toggle-row">
            <span class="agent-dot" style="background:${info.color}"></span> ${info.avatar}
          </div>
        `;
        el.appendChild(buildModelControl(key, info));
        el.style.borderColor = info.color;
        el.style.color = info.color;
        el.style.background = bgColor;
        container.appendChild(el);
      }

      // logo 显示 agent 数量
      const n = Object.keys(agents).length;
      document.getElementById("logo-text").textContent = `🤖 AI 群聊 × ${n}`;
      document.title = `AI 群聊 × ${n}`;

      // 动态生成状态栏指示器
      const statusBar = document.getElementById("status-bar");
      if (statusBar) {
        statusBar.innerHTML = "";
        for (const [key, info] of Object.entries(agents)) {
          const item = document.createElement("div");
          item.className = "status-item";
          item.id = `status-${key}`;
          item.innerHTML = `<span class="dot" style="background:${info.color};"></span> ${info.name}`;
          statusBar.appendChild(item);
        }
      }

      // 动态渲染欢迎屏
      showWelcome();
    } catch (e) {
      console.error("加载 agent 失败:", e);
      addSystemMessage("⚠️ 无法连接服务器，请确认 server.js 已启动后刷新页面");
    }
  }

  // 模型显示用短名（provider/model → model）
  function shortModel(m) { return (m || "").split("/").pop(); }

  // 构建模型选择控件：有 models 列表用下拉，否则静态文本
  function buildModelControl(key, info) {
    if (Array.isArray(info.models) && info.models.length > 0) {
      const saved = localStorage.getItem(`tri-model-${key}`);
      agentModels[key] = (saved && info.models.includes(saved)) ? saved : info.model;
      const sel = document.createElement("select");
      sel.className = "model-select";
      sel.title = "切换模型";
      for (const m of info.models) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = shortModel(m);
        sel.appendChild(opt);
      }
      sel.value = agentModels[key];
      sel.onclick = (e) => e.stopPropagation(); // 不触发 agent 开关
      sel.onchange = (e) => {
        e.stopPropagation();
        agentModels[key] = sel.value;
        localStorage.setItem(`tri-model-${key}`, sel.value);
      };
      return sel;
    }
    const badge = document.createElement("div");
    badge.className = "model-badge";
    badge.textContent = shortModel(info.model);
    return badge;
  }

  function toggleAgent(agent) {
    const el = document.querySelector(`.agent-toggle[data-agent="${agent}"]`);
    if (!el) return;
    if (selectedAgents.has(agent)) {
      selectedAgents.delete(agent);
      el.classList.remove("active");
      el.style.borderColor = "";
      el.style.color = "";
      el.style.background = "";
    } else {
      selectedAgents.add(agent);
      el.classList.add("active");
      const info = AGENT_INFO[agent];
      if (info) {
        el.style.borderColor = info.color;
        el.style.color = info.color;
        el.style.background = hexToRgba(info.color, 0.08);
      }
    }
  }

  // ===== 会话管理 =====
  let sessions = JSON.parse(localStorage.getItem("tri-sessions") || "[]");
  let currentSessionId = null;

  function saveSessions() {
    try {
      localStorage.setItem("tri-sessions", JSON.stringify(sessions));
    } catch (e) {
      // localStorage 满了：淘汰最旧的一半再试一次
      sessions = sessions.slice(0, Math.ceil(sessions.length / 2));
      try { localStorage.setItem("tri-sessions", JSON.stringify(sessions)); } catch {}
    }
  }

  function newSession() {
    if (isStreaming) stopGeneration();
    if (history.length > 0) saveCurrentSession();
    history = []; currentSessionId = null;
    document.getElementById("messages").innerHTML = "";
    showWelcome();
    renderHistoryList();
    document.getElementById("input").focus();
  }

  function saveCurrentSession() {
    if (history.length === 0) return;
    const firstMsg = history.find(h => h.sender === "你") || history[0];
    const title = (firstMsg.text || "").slice(0, 30) || "（空会话）";
    if (currentSessionId) {
      const s = sessions.find(s => s.id === currentSessionId);
      if (s) { s.history = [...history]; s.title = title; s.time = Date.now(); }
    } else {
      currentSessionId = "s" + Date.now();
      sessions.unshift({ id: currentSessionId, title, time: Date.now(), history: [...history] });
      if (sessions.length > 50) sessions = sessions.slice(0, 50);
    }
    saveSessions();
    renderHistoryList();
  }

  // 修复：历史会话加载时正确渲染 markdown（之前 escape 后显示源码，格式全丢）
  function loadSession(id) {
    const s = sessions.find(s => s.id === id);
    if (!s) return;
    if (isStreaming) stopGeneration();
    if (history.length > 0) saveCurrentSession();
    history = [...s.history]; currentSessionId = id;
    document.getElementById("messages").innerHTML = "";
    for (const msg of history) {
      if (!msg.agent || msg.agent === "user") {
        addMessage("user", escapeHtml(msg.text), null, false);
      } else {
        const bodyEl = addMessage(msg.agent, "", null, false);
        bodyEl.innerHTML = renderMarkdown(msg.text);
        highlightBlocks(bodyEl);
      }
    }
    renderHistoryList();
    // 移动端加载会话后收起侧边栏
    if (window.innerWidth <= 768 && !document.getElementById("sidebar").classList.contains("collapsed")) {
      toggleSidebar();
    }
  }

  function deleteSession(id) {
    sessions = sessions.filter(s => s.id !== id);
    if (currentSessionId === id) {
      currentSessionId = null;
      history = [];
      document.getElementById("messages").innerHTML = "";
      showWelcome();
    }
    saveSessions();
    renderHistoryList();
  }

  function renderHistoryList() {
    const list = document.getElementById("history-list");
    if (sessions.length === 0) {
      list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:12px;">暂无历史会话</div>';
      return;
    }
    list.innerHTML = sessions.map(s => `
      <div class="history-item ${s.id === currentSessionId ? 'active' : ''}" onclick="loadSession('${s.id}')">
        <div class="title">${escapeHtml(s.title)}</div>
        <div class="time">${new Date(s.time).toLocaleString("zh-CN", {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
        <button class="delete-btn" onclick="event.stopPropagation();deleteSession('${s.id}')" title="删除">✕</button>
      </div>
    `).join("");
  }

  // 导出当前会话为 Markdown 文件
  function exportSession() {
    if (history.length === 0) { addSystemMessage("暂无对话内容可导出"); return; }
    const lines = ["# AI 群聊记录", "", `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
    for (const msg of history) {
      lines.push(`## ${msg.sender}`, "", msg.text || "", "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
    addSystemMessage("✓ 已导出 Markdown 文件");
  }

  function toggleSidebar() {
    const sb = document.getElementById("sidebar");
    const ov = document.getElementById("sidebar-overlay");
    sb.classList.toggle("collapsed");
    ov.classList.toggle("show", !sb.classList.contains("collapsed") && window.innerWidth <= 768);
  }

  // ===== 主题（同步切换 hljs 代码高亮主题） =====
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    if (next === "dark") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", "light");
    document.getElementById("hljs-theme").href = HLJS_THEMES[next];
    localStorage.setItem("tri-theme", next);
  }
  const savedTheme = localStorage.getItem("tri-theme");
  if (savedTheme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    document.getElementById("hljs-theme").href = HLJS_THEMES.light;
  }

  // ===== 工具函数 =====
  function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith("#")) return `rgba(128, 128, 128, ${alpha})`;
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function changeThinking(mode) { thinkingMode = mode; localStorage.setItem("tri-thinking", mode); }
  function changeMode(mode) { chatMode = mode; localStorage.setItem("tri-mode", mode); }
  function changeRounds(v) { rounds = Number(v) || 1; localStorage.setItem("tri-rounds", String(rounds)); }
  function autoResize(t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 100) + "px"; }
  function formatTime() { return new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
  function escapeHtml(text) { const div = document.createElement("div"); div.textContent = text; return div.innerHTML; }

  // ===== @mention 解析（负向预测：支持中英文标点/换行/结尾） =====
  function parseMentions(text) {
    const mentions = [];
    // 按长度降序，避免短 key 优先误匹配（如 open vs opencode）
    const agentKeys = Object.keys(AGENT_INFO).filter(k => k !== "user").sort((a, b) => b.length - a.length);
    if (agentKeys.length === 0) return { cleaned: text.trim(), targets: [] };
    // key 需转义后再拼正则，避免含特殊字符（如 . + ）时匹配错乱
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`@(${agentKeys.map(escRe).join("|")}|all)(?![a-z0-9_-])`, "gi");
    const cleaned = text.replace(pattern, (m, name) => {
      mentions.push(name.toLowerCase());
      return "";
    }).replace(/\s{2,}/g, " ").trim();
    let targets;
    if (mentions.length === 0 || mentions.includes("all")) {
      targets = Array.from(selectedAgents);
    } else {
      targets = [...new Set(mentions)].filter(m => AGENT_INFO[m]);
    }
    return { cleaned, targets };
  }

  // ===== @mention 自动补全 =====
  const mentionPopup = document.getElementById("mention-popup");
  let mentionState = { open: false, items: [], index: 0, start: 0 };

  function updateMentionPopup() {
    const ta = document.getElementById("input");
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = before.match(/@([a-z0-9_-]*)$/i);
    if (!m) { closeMention(); return; }
    const partial = m[1].toLowerCase();
    const all = ["all", ...Object.keys(AGENT_INFO).filter(k => k !== "user")];
    const items = all.filter(k => k.toLowerCase().startsWith(partial) && k.toLowerCase() !== partial);
    if (items.length === 0) { closeMention(); return; }
    mentionState = { open: true, items, index: 0, start: pos - m[0].length };
    renderMentionPopup();
    // 定位到输入框上方
    const wrap = ta.getBoundingClientRect();
    mentionPopup.style.left = wrap.left + "px";
    mentionPopup.style.bottom = (window.innerHeight - wrap.top + 6) + "px";
    mentionPopup.style.display = "block";
  }

  function renderMentionPopup() {
    mentionPopup.innerHTML = mentionState.items.map((key, i) => {
      const info = key === "all"
        ? { color: "var(--text-dim)", name: "all", role: "发给全部" }
        : AGENT_INFO[key];
      const color = key === "all" ? "#71717a" : (info.color || "#71717a");
      return `<div class="mention-item ${i === mentionState.index ? "selected" : ""}" data-key="${key}">
        <span class="m-dot" style="background:${color}"></span>
        <span class="m-name">@${key}</span>
        <span class="m-role">${info.role || ""}</span>
      </div>`;
    }).join("");
    mentionPopup.querySelectorAll(".mention-item").forEach(el => {
      el.onmousedown = (e) => { e.preventDefault(); applyMention(el.dataset.key); };
    });
  }

  function applyMention(key) {
    const ta = document.getElementById("input");
    const before = ta.value.slice(0, mentionState.start);
    const after = ta.value.slice(ta.selectionStart);
    const inserted = "@" + key + " ";
    ta.value = before + inserted + after;
    const newPos = (before + inserted).length;
    ta.setSelectionRange(newPos, newPos);
    closeMention();
    ta.focus();
    autoResize(ta);
  }

  function closeMention() {
    mentionState.open = false;
    mentionPopup.style.display = "none";
  }

  function handleKey(e) {
    // mention 弹窗优先处理按键
    if (mentionState.open) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionState.index = (mentionState.index + 1) % mentionState.items.length; renderMentionPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionState.index = (mentionState.index - 1 + mentionState.items.length) % mentionState.items.length; renderMentionPopup(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionState.items[mentionState.index]); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMention(); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  // ===== 消息渲染 =====
  function showWelcome() {
    const m = document.getElementById("messages");
    if (m.querySelector("#welcome")) return;
    const agentKeys = Object.keys(AGENT_INFO).filter(k => k !== "user");
    const cards = agentKeys.map(key => {
      const a = AGENT_INFO[key];
      const color = a.color || "var(--text-dim)";
      return `<div class="agent-card">
        <div class="agent-icon" style="background:${hexToRgba(color, 0.08)};color:${color};border:1px solid ${color};">${a.avatar || "?"}</div>
        <span class="agent-name">${a.name || key}</span>
        <span class="agent-role">${a.role || ""}</span>
      </div>`;
    }).join("");
    const mentionHint = agentKeys.map(k => `<code>@${k}</code>`).join(" ");
    m.innerHTML = `<div id="welcome">
      <h2>AI 群聊</h2>
      <p>输入消息，所有 AI 会在同一个聊天里回复。<br>用 ${mentionHint} 定向发言，<code>@all</code> 发给全部。</p>
      <div class="agents">${cards}</div>
    </div>`;
  }

  function addMessage(agent, text, model, saveToHistory = true) {
    const welcome = document.getElementById("welcome");
    if (welcome) welcome.remove();
    const info = AGENT_INFO[agent] || { name: agent, role: "", avatar: "?" };
    const color = info.color || "var(--user)";
    const bgColor = hexToRgba(color, 0.08);
    const messagesEl = document.getElementById("messages");
    const msgEl = document.createElement("div");
    msgEl.className = `msg ${agent}`;
    const modelTag = model ? `<span class="msg-model">${model}</span>` : "";
    msgEl.innerHTML = `
      <div class="msg-avatar" style="background:${bgColor};color:${color};border:1px solid ${color};">${info.avatar}</div>
      <div class="msg-content">
        <div class="msg-header">
          <span class="msg-name" style="color:${color};">${info.name}</span>
          ${info.role ? `<span class="msg-role">${info.role}</span>` : ""}
          ${modelTag}
          <span class="msg-time">${formatTime()}</span>
        </div>
        <div class="msg-body"></div>
      </div>
    `;
    messagesEl.appendChild(msgEl);
    const bodyEl = msgEl.querySelector(".msg-body");
    bodyEl.innerHTML = text || "";
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (saveToHistory) {
      // 安全提取纯文本（通过 DOM 而非正则去标签）
      const tmp = document.createElement("div");
      tmp.innerHTML = text;
      history.push({ sender: agent === "user" ? "你" : info.name, text: tmp.textContent || "", agent });
    }
    return bodyEl;
  }

  // 系统提示消息（错误、导出成功等）
  function addSystemMessage(text) {
    const messagesEl = document.getElementById("messages");
    const el = document.createElement("div");
    el.className = "system-msg";
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addRoundDivider(n, total) {
    const messagesEl = document.getElementById("messages");
    const el = document.createElement("div");
    el.className = "round-divider";
    el.textContent = `第 ${n} / ${total} 轮`;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function highlightBlocks(bodyEl) {
    bodyEl.querySelectorAll("pre code").forEach(el => {
      if (el.dataset.highlighted) return;
      try { hljs.highlightElement(el); el.dataset.highlighted = "1"; } catch (e) {}
    });
  }

  // ===== rAF 节流渲染 =====
  function flushRender(agent) {
    const buf = streamBuffers[agent];
    if (!buf || !buf.dirty) return;
    buf.dirty = false;
    buf.bodyEl.innerHTML = renderMarkdown(buf.text || "") + '<span class="cursor"></span>';
    // 高亮已闭合的代码块
    const fenceCount = (buf.text.match(/```/g) || []).length;
    const blocks = buf.bodyEl.querySelectorAll("pre code");
    blocks.forEach((el, i) => {
      if (el.dataset.highlighted) return;
      const isOpen = (i === blocks.length - 1) && (fenceCount % 2 === 1);
      if (isOpen) return;
      try { hljs.highlightElement(el); el.dataset.highlighted = "1"; } catch (e) {}
    });
    // 智能自动滚动
    const m = document.getElementById("messages");
    const nearBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
    if (nearBottom) m.scrollTop = m.scrollHeight;
  }

  function getOrCreateStreamBody(agent) {
    if (streamBuffers[agent]?.bodyEl) return streamBuffers[agent].bodyEl;
    const bodyEl = addMessage(agent, "", null, false);
    streamBuffers[agent] = { bodyEl, text: "", thinking: true, dirty: false, rafId: null, startTime: Date.now() };
    bodyEl.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div>';
    return bodyEl;
  }

  function appendChunk(agent, chunk) {
    const buf = streamBuffers[agent];
    if (!buf) return;
    if (buf.thinking) { buf.thinking = false; buf.text = ""; }
    buf.text += chunk;
    buf.dirty = true;
    if (buf.rafId) return;
    buf.rafId = requestAnimationFrame(() => { buf.rafId = null; flushRender(agent); });
  }

  function finalizeStream(agent, fullText) {
    const buf = streamBuffers[agent];
    if (!buf) return;
    if (buf.rafId) { cancelAnimationFrame(buf.rafId); buf.rafId = null; }
    let finalText = buf.text || fullText || "(无回复)";
    if (stoppedByUser && buf.text) finalText += "\n\n*(已停止)*";
    buf.bodyEl.innerHTML = renderMarkdown(finalText);
    highlightBlocks(buf.bodyEl);

    // 响应耗时
    if (buf.startTime) {
      const elapsed = ((Date.now() - buf.startTime) / 1000).toFixed(1);
      const header = buf.bodyEl.closest(".msg")?.querySelector(".msg-header");
      if (header) {
        const span = document.createElement("span");
        span.className = "msg-elapsed";
        span.textContent = `⏱ ${elapsed}s`;
        header.appendChild(span);
      }
    }

    const info = AGENT_INFO[agent] || {};
    history.push({ sender: info.name || agent, text: finalText, agent });
    delete streamBuffers[agent];
    // 每个 agent 完成即保存一次会话，防止中途关页面丢失
    saveCurrentSession();
  }

  function setStatus(agent, visible) {
    const el = document.getElementById(`status-${agent}`);
    if (el) el.classList.toggle("visible", visible);
  }

  // ===== 代码复制（事件委托）=====
  document.getElementById("messages").addEventListener("click", (e) => {
    const btn = e.target.closest(".code-copy-btn");
    if (!btn) return;
    const code = btn.parentElement.querySelector("code");
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(() => {
      btn.textContent = "✓ 已复制";
      setTimeout(() => (btn.textContent = "复制"), 1500);
    });
  });

  // ===== 发送 / 停止 =====
  function stopUI() {
    isStreaming = false;
    document.getElementById("send").disabled = false;
    document.getElementById("stop").classList.remove("visible");
  }

  function stopGeneration() {
    stoppedByUser = true;
    if (abortController) abortController.abort();
  }

  async function sendMessage() {
    const input = document.getElementById("input");
    const raw = input.value.trim();
    if (!raw || isStreaming) return;
    closeMention();

    // 解析 @mention
    const { cleaned: text, targets } = parseMentions(raw);
    if (targets.length === 0) {
      addSystemMessage("⚠️ 没有可接收消息的 AI，请先在顶栏启用至少一个");
      return;
    }

    isStreaming = true;
    stoppedByUser = false;
    document.getElementById("send").disabled = true;
    document.getElementById("stop").classList.add("visible");
    input.value = "";
    autoResize(input);

    addMessage("user", escapeHtml(text));

    abortController = new AbortController();
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text, targets,
          history: history.slice(-6),
          thinking: thinkingMode,
          mode: chatMode,
          rounds,
          models: agentModels,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        addSystemMessage(`⚠️ 请求被拒绝: ${errData.error || response.status}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const evtStr of events) {
          const lines = evtStr.split("\n");
          let eventType = "", data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (!eventType || !data || eventType.startsWith(":")) continue;
          try { handleSSEEvent(eventType, JSON.parse(data)); } catch {}
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        addSystemMessage(`⚠️ 连接错误: ${err.message}`);
      }
    } finally {
      stopUI();
      for (const agent of Object.keys(streamBuffers)) finalizeStream(agent, "");
      saveCurrentSession();
    }
  }

  function handleSSEEvent(event, data) {
    switch (event) {
      case "thinking":
        getOrCreateStreamBody(data.agent);
        setStatus(data.agent, true);
        break;
      case "chunk":
        appendChunk(data.agent, data.chunk);
        break;
      case "done":
        finalizeStream(data.agent, data.text);
        setStatus(data.agent, false);
        break;
      case "round":
        addRoundDivider(data.round, data.total);
        break;
      case "error":
        finalizeStream(data.agent, `⚠️ ${data.error}`);
        setStatus(data.agent, false);
        break;
    }
  }

  // ===== 初始化 =====
  const inputEl = document.getElementById("input");
  inputEl.addEventListener("keydown", handleKey);
  inputEl.addEventListener("input", () => { autoResize(inputEl); updateMentionPopup(); });
  inputEl.addEventListener("click", updateMentionPopup);
  document.addEventListener("click", (e) => {
    if (!mentionPopup.contains(e.target) && e.target !== inputEl) closeMention();
  });

  // 恢复模式选择
  document.getElementById("mode-select").value = chatMode;
  document.getElementById("thinking-mode").value = thinkingMode;
  document.getElementById("rounds-select").value = String(rounds);

  // 移动端默认收起侧边栏
  if (window.innerWidth <= 768) {
    document.getElementById("sidebar").classList.add("collapsed");
  }

  loadAgents();
  renderHistoryList();
  inputEl.focus();
