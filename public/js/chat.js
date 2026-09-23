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

  // markdown 渲染 + XSS 消毒（DOMPurify 缺失时按纯文本转义渲染，绝不直接注入 marked 输出）
  function renderMarkdown(text) {
    let html = marked.parse(text || "");
    if (window.DOMPurify) return DOMPurify.sanitize(html);
    return escapeHtml(text || "");
  }

  // ===== 全局状态 =====
  const AGENT_INFO = { user: { name: "你", role: "", avatar: "你" } };
  const selectedAgents = new Set();
  let history = [];
  let isStreaming = false;
  let stoppedByUser = false;
  let currentRound = 1;        // 多轮讨论当前轮（round 事件更新，写进 history 供恢复）
  let currentRoundTotal = 1;   // 本轮讨论总轮数
  let thinkingMode = localStorage.getItem("tri-thinking") || "medium";
  let chatMode = localStorage.getItem("tri-mode") || "parallel";
  let rounds = Number(localStorage.getItem("tri-rounds")) || 1;
  let abortController = null;
  const streamBuffers = {};
  const agentModels = {}; // 每个 agent 当前选中的模型

  const HLJS_THEMES = {
    dark: "/vendor/hljs-github-dark.min.css",
    light: "/vendor/hljs-github.min.css",
  };

  // ===== 动态渲染 agent 按钮 =====
  async function loadAgents() {
    try {
      const res = await OPS.api("/api/models");
      const agents = await res.json();
      const container = document.getElementById("agent-toggles");
      container.innerHTML = "";
      selectedAgents.clear();

      for (const [key, info] of Object.entries(agents)) {
        const bgColor = hexToRgba(info.color, 0.08);

        // 注册 agent 信息（含可用性：换电脑后本机没装的 CLI 会 available=false）
        AGENT_INFO[key] = { name: info.name, role: info.role, avatar: info.avatar, model: info.model, color: info.color, available: info.available, installId: info.installId };

        // 创建 toggle 按钮
        const el = document.createElement("div");
        el.dataset.agent = key;

        if (info.available) {
          selectedAgents.add(key);
          el.className = "agent-toggle active";
          el.onclick = () => toggleAgent(key);
          el.innerHTML = `
            <div class="agent-toggle-row">
              <span class="agent-dot" style="background:${info.color}"></span> ${escapeHtml(info.avatar)}
            </div>
          `;
          el.appendChild(buildModelControl(key, info));
          el.style.borderColor = info.color;
          el.style.color = info.color;
          el.style.background = bgColor;
        } else {
          // 未安装：灰显 + 点击一键安装（或提示手动安装）
          el.className = "agent-toggle unavailable";
          el.title = `本机未安装 ${info.name} 的 CLI，点击安装`;
          el.innerHTML = `
            <div class="agent-toggle-row">
              <span class="agent-dot"></span> ${escapeHtml(info.avatar)}
            </div>
            <div class="model-badge missing">未安装 ⬇</div>
          `;
          el.onclick = () => installAgent(key, info);
        }
        container.appendChild(el);
      }

      // logo 显示可用 agent 数量
      const n = [...Object.values(AGENT_INFO)].filter(a => a.available !== false && a.name !== "你").length;
      document.getElementById("logo-text").textContent = `🤖 AI 群聊 × ${n}`;
      document.title = `AI 群聊 × ${n}`;

      // 状态栏只列可用 agent
      const statusBar = document.getElementById("status-bar");
      if (statusBar) {
        statusBar.innerHTML = "";
        for (const [key, info] of Object.entries(agents)) {
          if (!info.available) continue;
          const item = document.createElement("div");
          item.className = "status-item";
          item.id = `status-${key}`;
          item.innerHTML = `<span class="dot" style="background:${info.color};"></span> ${escapeHtml(info.name)}`;
          statusBar.appendChild(item);
        }
      }

      // 动态渲染欢迎屏
      showWelcome();
    } catch (e) {
      console.error("加载 agent 失败:", e);
      addSystemMessage("⚠️ 无法连接服务器，请确认 npm start 已启动后刷新页面");
    }
  }

  // 未安装 agent 的一键安装入口
  function installAgent(key, info) {
    if (info.installId && window.Installer) {
      Installer.install(info.installId, {
        name: info.name, icon: info.avatar,
        onDone: () => { addSystemMessage(`✓ ${info.name} 安装完成，正在刷新…`); setTimeout(loadAgents, 800); },
      });
    } else {
      addSystemMessage(`⚠️ ${info.name} 暂无自动安装方式，请手动安装其 CLI 后刷新页面（或去控制台「快捷安装」看看）`);
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
  // localStorage 可能被截断/损坏：解析失败回退为空，不让整页脚本挂掉
  let sessions = (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("tri-sessions") || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  })();
  let currentSessionId = null;
  let storageWarned = false;

  function saveSessions() {
    try {
      localStorage.setItem("tri-sessions", JSON.stringify(sessions));
      storageWarned = false;
    } catch (e) {
      // localStorage 满了：淘汰最旧的一半再试一次
      sessions = sessions.slice(0, Math.ceil(sessions.length / 2));
      try { localStorage.setItem("tri-sessions", JSON.stringify(sessions)); }
      catch {
        // 两次都失败：提示一次（flag 防刷屏），不再静默吞掉
        if (!storageWarned) {
          storageWarned = true;
          addSystemMessage("⚠️ 本地存储已满，最早的会话可能无法保存；建议导出或删除旧会话");
        }
      }
    }
  }

  function newSession() {
    if (isStreaming) stopGeneration();
    if (history.length > 0) saveCurrentSession();
    history = []; currentSessionId = null;
    document.getElementById("messages").innerHTML = "";
    showWelcome();
    updateRegenButton();
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

  // 按当前 history 重绘整个消息区（加载会话 / 重新生成共用；markdown 正常渲染）
  // agent 消息带 round 字段时重建「第 n / t 轮」分隔条（旧会话无该字段则不显示）
  function renderHistoryMessages() {
    document.getElementById("messages").innerHTML = "";
    let lastRound = 1;
    for (const msg of history) {
      if (!msg.agent || msg.agent === "user") {
        lastRound = 1; // 新一轮用户提问，轮次重新从 1 计
        addMessage("user", escapeHtml(msg.text), null, false);
      } else {
        if (msg.round && msg.round !== lastRound) {
          addRoundDivider(msg.round, msg.roundsTotal || msg.round);
          lastRound = msg.round;
        }
        const bodyEl = addMessage(msg.agent, "", null, false);
        bodyEl.innerHTML = renderMarkdown(msg.text);
        highlightBlocks(bodyEl);
      }
    }
  }

  function loadSession(id) {
    const s = sessions.find(s => s.id === id);
    if (!s) return;
    if (isStreaming) stopGeneration();
    if (history.length > 0) saveCurrentSession();
    history = [...s.history]; currentSessionId = id;
    renderHistoryMessages();
    updateRegenButton();
    renderHistoryList();
    // 移动端加载会话后收起侧边栏
    if (window.innerWidth <= 768 && !document.getElementById("sidebar").classList.contains("collapsed")) {
      toggleSidebar();
    }
  }

  function deleteSession(id) {
    sessions = sessions.filter(s => s.id !== id);
    if (currentSessionId === id) {
      // 流式中删除当前会话：先停止，避免后续回复凭空生成孤儿会话
      if (isStreaming) stopGeneration();
      currentSessionId = null;
      history = [];
      document.getElementById("messages").innerHTML = "";
      showWelcome();
      updateRegenButton();
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

  // 导出当前会话为 Markdown 文件（agent 消息带轮次时输出轮次标题）
  function exportSession() {
    if (history.length === 0) { addSystemMessage("暂无对话内容可导出"); return; }
    const lines = ["# AI 群聊记录", "", `导出时间：${new Date().toLocaleString("zh-CN")}`, ""];
    let lastRound = 1;
    for (const msg of history) {
      if (!msg.agent || msg.agent === "user") {
        lastRound = 1;
      } else if (msg.round && msg.round !== lastRound) {
        lines.push(`### 第 ${msg.round} / ${msg.roundsTotal || msg.round} 轮`, "");
        lastRound = msg.round;
      }
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
    localStorage.setItem("ops-theme", next); // 与控制台/终端页统一 key，主题真正同步
  }
  const savedTheme = localStorage.getItem("ops-theme") || localStorage.getItem("tri-theme");
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
  function escapeHtml(text) { const div = document.createElement("div"); div.textContent = text; return div.innerHTML.replace(/"/g, "&quot;"); }

  // ===== @mention 解析（左边界防 a@pi.example 误匹配；保留换行/缩进原文）=====
  function parseMentions(text) {
    const mentions = [];
    // 按长度降序，避免短 key 优先误匹配（如 open vs opencode）
    const agentKeys = Object.keys(AGENT_INFO).filter(k => k !== "user").sort((a, b) => b.length - a.length);
    if (agentKeys.length === 0) return { cleaned: text.trim(), targets: [] };
    // key 需转义后再拼正则，避免含特殊字符（如 . + ）时匹配错乱；
    // 左侧 lookbehind 排除紧贴字母/数字/下划线/@ 的 @（邮箱、代码）；
    // 右侧只吞一个空格，其余空白（空行、缩进）原样保留给 AI
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let pattern;
    try {
      pattern = new RegExp(`(?<![a-z0-9_@])@(${agentKeys.map(escRe).join("|")}|all)(?![a-z0-9_-])[ \\t]?`, "gi");
    } catch {
      // 老引擎不支持 lookbehind：退化为无左边界的版本（仍不折叠空白）
      pattern = new RegExp(`@(${agentKeys.map(escRe).join("|")}|all)(?![a-z0-9_-])[ \\t]?`, "gi");
    }
    const cleaned = text.replace(pattern, (m, name) => {
      mentions.push(name.toLowerCase());
      return "";
    }).trim();
    let targets;
    if (mentions.length === 0 || mentions.includes("all")) {
      targets = Array.from(selectedAgents);
    } else {
      // 只保留本机可用的 agent（@了未安装的直接忽略）
      targets = [...new Set(mentions)].filter(m => AGENT_INFO[m] && AGENT_INFO[m].available !== false);
    }
    return { cleaned, targets };
  }

  // ===== @mention 自动补全 =====
  const mentionPopup = document.getElementById("mention-popup");
  let mentionState = { open: false, items: [], index: 0, start: 0 };
  let mentionSuppressed = false; // 用户按 Escape 主动关闭后，点击输入框不再强行重开

  function updateMentionPopup() {
    if (mentionSuppressed) return; // 重新键入（input 事件）才会解除抑制
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
        ? { color: "var(--text-dim)", name: "all", role: "发给全部已启用" }
        : AGENT_INFO[key];
      const color = key === "all" ? "#71717a" : (info.color || "#71717a");
      const missing = key !== "all" && info.available === false;
      return `<div class="mention-item ${i === mentionState.index ? "selected" : ""}${missing ? " missing" : ""}" data-key="${escapeHtml(key)}">
        <span class="m-dot" style="background:${color}"></span>
        <span class="m-name">@${escapeHtml(key)}</span>
        <span class="m-role">${escapeHtml(info.role || "")}${missing ? " · 未安装" : ""}</span>
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
    // 中文输入法组词期（Enter 上屏/方向键选词）不触发发送与弹窗操作
    if (e.isComposing || e.keyCode === 229) return;
    // mention 弹窗优先处理按键
    if (mentionState.open) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionState.index = (mentionState.index + 1) % mentionState.items.length; renderMentionPopup(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionState.index = (mentionState.index - 1 + mentionState.items.length) % mentionState.items.length; renderMentionPopup(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyMention(mentionState.items[mentionState.index]); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMention(); mentionSuppressed = true; return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  // ===== 消息渲染 =====
  function showWelcome() {
    const m = document.getElementById("messages");
    if (m.querySelector("#welcome")) return;
    const agentKeys = Object.keys(AGENT_INFO).filter(k => k !== "user");
    const availableKeys = agentKeys.filter(k => AGENT_INFO[k].available !== false);
    const cards = agentKeys.map(key => {
      const a = AGENT_INFO[key];
      const color = a.color || "var(--text-dim)";
      const missing = a.available === false;
      return `<div class="agent-card${missing ? " missing" : ""}">
        <div class="agent-icon" style="background:${hexToRgba(color, 0.08)};color:${color};border:1px solid ${color};">${escapeHtml(a.avatar || "?")}</div>
        <span class="agent-name">${escapeHtml(a.name || key)}${missing ? " · 未安装" : ""}</span>
        <span class="agent-role">${escapeHtml(a.role || "")}</span>
      </div>`;
    }).join("");
    const mentionHint = availableKeys.map(k => `<code>@${escapeHtml(k)}</code>`).join(" ") || "<code>（暂无可用）</code>";
    const noAgentHint = availableKeys.length === 0
      ? `<div class="welcome-warn">⚠️ 本机未检测到任何可用的 AI CLI。<br>去控制台 <a href="/">「快捷安装」</a> 一键装上 Codex / Claude Code / Gemini 等 CLI 后再来。</div>`
      : "";
    m.innerHTML = `<div id="welcome">
      <h2>AI 群聊</h2>
      <p>输入消息，所有 AI 会在同一个聊天里回复。<br>用 ${mentionHint} 定向发言，<code>@all</code> 发给全部已启用的 AI。</p>
      ${noAgentHint}
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
    // name/role/avatar/model 均来自 agents.config.json（成员面板可自由编辑），必须转义防存储型 XSS
    const modelTag = model ? `<span class="msg-model">${escapeHtml(shortModel(model))}</span>` : "";
    msgEl.innerHTML = `
      <div class="msg-avatar" style="background:${bgColor};color:${color};border:1px solid ${color};">${escapeHtml(info.avatar)}</div>
      <div class="msg-content">
        <div class="msg-header">
          <span class="msg-name" style="color:${color};">${escapeHtml(info.name)}</span>
          ${info.role ? `<span class="msg-role">${escapeHtml(info.role)}</span>` : ""}
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

  // ===== 流式渲染节流 =====
  // 整体重设 innerHTML 会丢失已高亮状态，长回复下每帧全量 marked+hljs 会卡顿；
  // 限制重渲染频率为最低 120ms 一次，流畅度不受影响
  const STREAM_FLUSH_MS = 120;

  function flushRender(agent) {
    const buf = streamBuffers[agent];
    if (!buf || !buf.dirty) return;
    buf.dirty = false;
    buf.lastFlush = Date.now();
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

  function getOrCreateStreamBody(agent, model) {
    if (streamBuffers[agent]?.bodyEl) return streamBuffers[agent].bodyEl;
    const bodyEl = addMessage(agent, "", model, false);
    streamBuffers[agent] = { bodyEl, text: "", thinking: true, dirty: false, rafId: null, lastFlush: 0, startTime: Date.now() };
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
    // rafId 持有的是节流定时器：距上次渲染不足 120ms 时延迟补齐
    const wait = buf.lastFlush ? Math.max(0, buf.lastFlush + STREAM_FLUSH_MS - Date.now()) : 0;
    buf.rafId = setTimeout(() => { buf.rafId = null; flushRender(agent); }, wait);
  }

  function finalizeStream(agent, fullText) {
    const buf = streamBuffers[agent];
    if (!buf) return;
    if (buf.rafId) { clearTimeout(buf.rafId); buf.rafId = null; }
    // 停止时一个字都没吐出的 agent：移除气泡、不入历史，不伪装成「无回复」
    if (!buf.text && !fullText && stoppedByUser) {
      buf.bodyEl.closest(".msg")?.remove();
      delete streamBuffers[agent];
      return;
    }
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
    // 记录轮次（多轮讨论重载/导出时可重建分隔条；单轮时 round=1 不落字段，兼容旧会话）
    const entry = { sender: info.name || agent, text: finalText, agent };
    if (currentRound > 1) { entry.round = currentRound; entry.roundsTotal = currentRoundTotal; }
    history.push(entry);
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
    updateRegenButton();
  }

  function stopGeneration() {
    stoppedByUser = true;
    if (abortController) abortController.abort();
  }

  // 重新生成最后一轮：截断到该轮用户消息之前，用原始输入（含 @mention）重发
  function regenerateLast() {
    if (isStreaming) return;
    let idx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (!history[i].agent || history[i].agent === "user") { idx = i; break; }
    }
    if (idx === -1) { addSystemMessage("暂无可重新生成的消息"); return; }

    const raw = history[idx].raw || history[idx].text;
    // 先校验还有可用的接收者，避免截断后发不出去
    const { targets } = parseMentions(raw);
    if (targets.length === 0) {
      addSystemMessage("⚠️ 没有可接收消息的 AI，请先在顶栏启用至少一个");
      return;
    }

    history.length = idx; // 丢掉该轮用户消息及其后的所有回复
    renderHistoryMessages();
    if (history.length === 0) showWelcome();
    saveCurrentSession();
    void dispatchMessage(raw);
  }

  // 「重新生成」按钮可见性：非流式且存在至少一条用户消息
  function updateRegenButton() {
    const btn = document.getElementById("regen");
    if (!btn) return;
    const hasUser = history.some(h => !h.agent || h.agent === "user");
    btn.classList.toggle("visible", !isStreaming && hasUser);
  }

  async function sendMessage() {
    const input = document.getElementById("input");
    const raw = input.value.trim();
    if (!raw || isStreaming) return;
    closeMention();

    // 发送即清空输入框；若目标校验未通过，再恢复原输入便于修改重发
    input.value = "";
    autoResize(input);

    const ok = await dispatchMessage(raw);
    if (!ok) {
      input.value = raw;
      autoResize(input);
    }
  }

  // 统一发送入口（sendMessage / 重新生成 共用）
  // 返回 false 表示未发出（校验失败，输入框内容应保留）
  async function dispatchMessage(raw) {
    // 解析 @mention
    const { cleaned: text, targets } = parseMentions(raw);
    if (targets.length === 0) {
      addSystemMessage("⚠️ 没有可接收消息的 AI，请先在顶栏启用至少一个");
      return false;
    }

    // 先快照历史（不含本条消息）再渲染用户气泡：
    // 避免当前消息既进 history 又作为 message 发送，在 prompt 中重复出现
    const historySnapshot = history.slice(-12);

    isStreaming = true;
    stoppedByUser = false;
    currentRound = 1;
    currentRoundTotal = rounds;
    document.getElementById("send").disabled = true;
    document.getElementById("stop").classList.add("visible");
    updateRegenButton();

    addMessage("user", escapeHtml(text));
    // 记录原始输入（含 @mention），供「重新生成」按原样重发
    const lastEntry = history[history.length - 1];
    if (lastEntry && (!lastEntry.agent || lastEntry.agent === "user")) lastEntry.raw = raw;

    abortController = new AbortController();
    try {
      const response = await OPS.api("/api/chat", {
        method: "POST",
        signal: abortController.signal,
        json: {
          message: text, targets,
          history: historySnapshot, // 与服务端上限（20 条）对齐；不含当前消息
          thinking: thinkingMode,
          mode: chatMode,
          rounds,
          models: agentModels,
        },
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        addSystemMessage(`⚠️ 请求被拒绝: ${errData.error || response.status}`);
        return true;
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
      for (const agent of Object.keys(streamBuffers)) {
        const buf = streamBuffers[agent];
        // 切换/新建会话会 abort 流并先替换 history：已脱离文档的流块不能再写进当前会话
        if (buf && !buf.bodyEl.isConnected) { delete streamBuffers[agent]; continue; }
        setStatus(agent, false); // abort 后 done 不会到达，状态点在此统一熄灭
        finalizeStream(agent, "");
      }
      saveCurrentSession();
    }
    return true;
  }

  function handleSSEEvent(event, data) {
    switch (event) {
      case "thinking":
        getOrCreateStreamBody(data.agent, data.model);
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
        currentRound = data.round;
        currentRoundTotal = data.total;
        addRoundDivider(data.round, data.total);
        break;
      case "error":
        finalizeStream(data.agent, `⚠️ ${data.error}`);
        setStatus(data.agent, false);
        break;
    }
  }

  // 关页/刷新前把未完成的流式回复落盘（标记「已停止」），防止中途关页全丢
  window.addEventListener("pagehide", () => {
    if (!isStreaming) return;
    stoppedByUser = true;
    for (const agent of Object.keys(streamBuffers)) {
      const buf = streamBuffers[agent];
      if (!buf || !buf.bodyEl.isConnected) { if (buf) delete streamBuffers[agent]; continue; }
      finalizeStream(agent, "");
    }
    saveCurrentSession();
  });

  // ===== 初始化 =====
  const inputEl = document.getElementById("input");
  inputEl.addEventListener("keydown", handleKey);
  inputEl.addEventListener("input", () => { autoResize(inputEl); mentionSuppressed = false; updateMentionPopup(); });
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
  updateRegenButton();
  inputEl.focus();
