"use strict";
/* =========================================================================
   AI 群聊 — 本地 API Key 管理（读写 ~/.secrets.env）
   依赖：window.OPS
   ========================================================================= */
window.Secrets = (() => {
  let secretPath = "";
  // S06/D1：服务端只返回掩码，页面不回显旧值。
  // 已有条目 = 键名只读、值留空（留空 = 保持不变）；被移除的已有键在保存时以空值提交（删除）。
  let removedExisting = new Set();

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

  function rowHtml(key) {
    return `<div class="secret-row" data-key="${esc(key)}">
      <input class="secret-key" value="${esc(key)}" readonly placeholder="变量名">
      <div class="secret-value-wrap">
        <input class="secret-value" type="password" value="" placeholder="留空 = 保持不变">
      </div>
      <button class="remove-btn" data-act="remove">移除</button>
    </div>`;
  }

  function render(vars) {
    const list = el("secrets-list");
    removedExisting = new Set();
    if (Object.keys(vars).length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">还没有 Key，点下方「添加一行」。</div>';
      return;
    }
    list.innerHTML = Object.keys(vars).map((k) => rowHtml(k)).join("");
  }

  function addRow() {
    const list = el("secrets-list");
    const row = document.createElement("div");
    row.className = "secret-row";
    row.innerHTML = `<input class="secret-key" placeholder="变量名">
      <div class="secret-value-wrap">
        <input class="secret-value" type="password" placeholder="值">
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
      const keyInput = row.querySelector(".secret-key");
      const valueInput = row.querySelector(".secret-value");
      const value = valueInput.value;
      if (keyInput.readOnly) {
        // 已有条目：留空 = 保持不变；输入新值 = 覆盖
        const key = keyInput.value;
        if (key && value !== "" && !removedExisting.has(key)) vars[key] = value;
        continue;
      }
      const key = keyInput.value.trim();
      if (key && value !== "") vars[key] = value; // 新行：键值都非空才提交
    }
    for (const key of removedExisting) {
      if (!(key in vars)) vars[key] = ""; // 被移除的已有键 = 删除；若同轮重新添加则保留新值
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
      alert("已保存并立即生效；重启服务后会自动加载（不覆盖启动时已设置的同名变量）。");
    } catch (e) {
      alert("保存失败：" + e.message);
    }
  }

  el("secrets-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const row = btn.closest(".secret-row");
    if (btn.dataset.act === "remove") {
      const keyInput = row.querySelector(".secret-key");
      if (keyInput.readOnly && keyInput.value) removedExisting.add(keyInput.value);
      row.remove();
    }
  });

  el("secrets-overlay")?.addEventListener("click", (e) => {
    if (e.target === el("secrets-overlay")) close();
  });

  return { open, close, addRow, save };
})();