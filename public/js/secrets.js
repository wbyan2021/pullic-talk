"use strict";
/* =========================================================================
   AI 群聊 — 本地 API Key 管理（读写 ~/.secrets.env）
   依赖：window.OPS
   ========================================================================= */
window.Secrets = (() => {
  let secretPath = "";

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function open() {
    el("secrets-overlay").classList.remove("hidden");
    fetchSecrets();
  }

  function close() {
    el("secrets-overlay").classList.add("hidden");
  }

  async function fetchSecrets() {
    const list = el("secrets-list");
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">加载中…</div>';
    try {
      const res = await window.OPS.api("/api/secrets");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
      secretPath = data.path || "";
      el("secrets-path").textContent = "文件：" + secretPath;
      render(data.vars || {});
    } catch (e) {
      list.innerHTML = `<div style="color:#ef4444;font-size:12px;">加载失败：${esc(e.message)}</div>`;
    }
  }

  function rowHtml(key, value) {
    return `<div class="secret-row" data-key="${esc(key)}">
      <input class="secret-key" value="${esc(key)}" placeholder="变量名">
      <div class="secret-value-wrap">
        <input class="secret-value" type="password" value="${esc(value)}" placeholder="值">
        <button class="reveal-btn" data-act="reveal">显示</button>
      </div>
      <button class="remove-btn" data-act="remove">移除</button>
    </div>`;
  }

  function render(vars) {
    const list = el("secrets-list");
    if (Object.keys(vars).length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">还没有 Key，点下方「添加一行」。</div>';
      return;
    }
    list.innerHTML = Object.entries(vars).map(([k, v]) => rowHtml(k, v)).join("");
  }

  function addRow() {
    const list = el("secrets-list");
    const empty = list.querySelector(".secret-row") ? false : true;
    const row = document.createElement("div");
    row.className = "secret-row";
    row.innerHTML = `<input class="secret-key" placeholder="变量名">
      <div class="secret-value-wrap">
        <input class="secret-value" type="password" placeholder="值">
        <button class="reveal-btn" data-act="reveal">显示</button>
      </div>
      <button class="remove-btn" data-act="remove">移除</button>`;
    list.appendChild(row);
    const inputs = row.querySelectorAll("input");
    if (inputs.length > 0) inputs[0].focus();
  }

  function collect() {
    const vars = {};
    const rows = el("secrets-list").querySelectorAll(".secret-row");
    for (const row of rows) {
      const key = row.querySelector(".secret-key").value.trim();
      const value = row.querySelector(".secret-value").value;
      if (key) vars[key] = value;
    }
    return vars;
  }

  async function save() {
    const vars = collect();
    try {
      const res = await window.OPS.api("/api/secrets", {
        method: "POST",
        json: { vars },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
      render(data.vars || {});
      alert("已保存。新值在重新打开的终端中生效；当前服务会继承服务器启动时的 Key。");
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  }

  el("secrets-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest(".secret-row");
    if (btn.dataset.act === "remove") {
      row.remove();
    } else if (btn.dataset.act === "reveal") {
      const input = row.querySelector(".secret-value");
      const isPassword = input.type === "password";
      input.type = isPassword ? "text" : "password";
      btn.textContent = isPassword ? "隐藏" : "显示";
    }
  });

  el("secrets-overlay")?.addEventListener("click", (e) => {
    if (e.target === el("secrets-overlay")) close();
  });

  return { open, close, addRow, save };
})();