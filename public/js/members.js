"use strict";
/* =========================================================================
   AI 群聊 — 群成员与模型维护面板
   依赖：window.OPS（ops.js，token 自动夹带）；window.loadAgents（chat.js）
   ========================================================================= */
window.Members = (() => {
  let members = {};

  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function open() {
    el("members-overlay").classList.remove("hidden");
    fetchMembers();
  }

  function close() {
    el("members-overlay").classList.add("hidden");
  }

  async function fetchMembers() {
    const list = el("members-list");
    list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">加载中…</div>';
    try {
      const res = await window.OPS.api("/api/members");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
      members = data.members || {};
      render();
    } catch (e) {
      list.innerHTML = `<div style="color:#ef4444;font-size:12px;">加载失败：${esc(e.message)}</div>`;
    }
  }

  function render() {
    const list = el("members-list");
    const rows = Object.values(members).map((m) => {
      const status = !m.enabled
        ? '<span class="member-status">已停用</span>'
        : m.available
          ? '<span class="member-status available">可用</span>'
          : '<span class="member-status missing">未安装 CLI</span>';
      const models = (m.models || []).join(", ");
      const avatarColor = m.color || "#71717a";
      return `<div class="member-row" data-key="${esc(m.key)}">
        <div class="member-avatar${m.enabled ? "" : " off"}" style="color:${avatarColor};border:1px solid ${avatarColor};background:${hexToRgba(avatarColor, 0.08)};">${esc(m.avatar)}</div>
        <div class="member-main">
          <div class="member-title">
            <strong>${esc(m.name)}</strong>
            <span class="member-key">${esc(m.key)}</span>
            ${m.cliCommand ? `<span class="member-key">cmd: ${esc(m.cliCommand)}</span>` : ""}
            ${status}
            <span class="member-status">${esc(m.role || "")}</span>
          </div>
          <div class="member-fields">
            <label>默认模型
              <input id="m-model-${esc(m.key)}" value="${esc(m.model)}" placeholder="${m.builtin ? "继承内置默认" : "model"}">
            </label>
            <label>可选模型（逗号分隔）
              <input id="m-models-${esc(m.key)}" value="${esc(models)}" placeholder="gpt-5, claude-4">
            </label>
            <label>角色说明
              <input id="m-role-${esc(m.key)}" value="${esc(m.role)}">
            </label>
          </div>
        </div>
        <div class="member-actions">
          <button class="btn-primary" onclick="Members.save('${esc(m.key)}')">保存</button>
          <button class="toggle" onclick="Members.toggle('${esc(m.key)}', ${m.enabled ? "false" : "true"})">${m.enabled ? "停用" : "启用"}</button>
          ${m.builtin ? "" : `<button class="btn-danger" onclick="Members.remove('${esc(m.key)}')">删除</button>`}
        </div>
      </div>`;
    }).join("");

    list.innerHTML = rows || '<div style="color:var(--text-muted);font-size:12px;">暂无成员</div>';
  }

  function hexToRgba(hex, a) {
    if (!hex || !hex.startsWith("#")) return `rgba(128,128,128,${a})`;
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    return `rgba(${r},${g},${b},${a})`;
  }

  function splitModels(str) {
    const raw = String(str || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    return [...new Set(raw)];
  }

  async function save(key) {
    const m = members[key];
    if (!m) return;
    const patch = {
      model: el(`m-model-${key}`)?.value?.trim() ?? "",
      models: splitModels(el(`m-models-${key}`)?.value ?? ""),
      role: el(`m-role-${key}`)?.value?.trim() ?? "",
    };
    try {
      const res = await window.OPS.api(`/api/members/${encodeURIComponent(key)}`, {
        method: "PUT", json: patch,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      localStorage.removeItem(`tri-model-${key}`); // 让新默认模型即时生效
      window.loadAgents?.();
      await fetchMembers();
    } catch (e) {
      alert(`保存 ${key} 失败：${e.message}`);
    }
  }

  async function toggle(key, enabled) {
    try {
      const res = await window.OPS.api(`/api/members/${encodeURIComponent(key)}`, {
        method: "PUT", json: { enabled: !!enabled },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      window.loadAgents?.();
      await fetchMembers();
    } catch (e) {
      alert(`操作 ${key} 失败：${e.message}`);
    }
  }

  async function remove(key) {
    if (!window.confirm(`确定要从配置中删除成员 ${key} 吗？`)) return;
    try {
      const res = await window.OPS.api(`/api/members/${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      localStorage.removeItem(`tri-model-${key}`);
      window.loadAgents?.();
      await fetchMembers();
    } catch (e) {
      alert(`删除 ${key} 失败：${e.message}`);
    }
  }

  async function add() {
    const key = el("m-add-key").value.trim();
    const name = el("m-add-name").value.trim() || key;
    const command = el("m-add-command").value.trim();
    const argsRaw = el("m-add-args").value.trim();
    const role = el("m-add-role").value.trim();
    const model = el("m-add-model").value.trim();
    const models = splitModels(el("m-add-models").value);
    const parseMode = el("m-add-parse").value;

    if (!/^[a-z0-9_-]{1,30}$/.test(key)) { alert("key 仅允许小写字母/数字/下划线/连字符（1–30 位）"); return; }
    if (!command) { alert("请填写 CLI 命令"); return; }

    const body = {
      key, name, role, model, models,
      cli: {
        command,
        parseMode,
        stdio: "ignore",
      },
    };
    if (argsRaw) {
      body.cli.args = argsRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }

    try {
      const res = await window.OPS.api("/api/members", { method: "POST", json: body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      localStorage.removeItem(`tri-model-${key}`);
      await fetchMembers();
      if (window.loadAgents) await window.loadAgents();
      el("m-add-key").value = "";
      el("m-add-name").value = "";
      el("m-add-command").value = "";
      el("m-add-args").value = "";
      el("m-add-role").value = "";
      el("m-add-model").value = "";
      el("m-add-models").value = "";
    } catch (e) {
      alert(`添加成员失败：${e.message}`);
    }
  }

  // 点遮罩关闭面板
  el("members-overlay")?.addEventListener("click", (e) => {
    if (e.target === el("members-overlay")) close();
  });

  return { open, close, save, toggle, remove, add };
})();