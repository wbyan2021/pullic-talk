"use strict";
/* ═══════════════════════════════════════════
   AI·OPS DECK — 快捷安装弹窗（控制台 & 群聊页共用）
   用法：Installer.install("cursor", { onDone: () => ... })
   ═══════════════════════════════════════════ */
window.Installer = (() => {
  const { api, esc } = window.OPS;
  let overlay = null;
  let pollTimer = null;

  function buildDom() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "installer-overlay";
    overlay.innerHTML = `
      <div class="inst-card">
        <div class="inst-head">
          <span class="inst-icon" id="inst-icon">📦</span>
          <div class="inst-tt">
            <div class="inst-name" id="inst-name">安装</div>
            <div class="inst-cmd" id="inst-cmd"></div>
          </div>
          <button class="inst-x" id="inst-close" title="关闭（安装继续在后台进行）">✕</button>
        </div>
        <pre class="inst-log" id="inst-log"></pre>
        <div class="inst-foot">
          <span class="inst-state" id="inst-state">准备中…</span>
          <button class="inst-btn" id="inst-action" style="display:none">完 成</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("#inst-close").onclick = close;
    overlay.querySelector("#inst-action").onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    return overlay;
  }

  function close() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (overlay) overlay.classList.remove("show");
  }

  function setState(kind, text) {
    const el = document.getElementById("inst-state");
    el.textContent = text;
    el.dataset.state = kind;
  }

  function renderLog(lines) {
    const pre = document.getElementById("inst-log");
    pre.textContent = lines.join("\n");
    pre.scrollTop = pre.scrollHeight;
  }

  async function poll(jobId, opts) {
    let fails = 0;
    pollTimer = setInterval(async () => {
      try {
        const res = await api(`/api/install/job/${jobId}`);
        if (!res.ok) throw new Error("job fetch failed");
        const job = await res.json();
        fails = 0;
        document.getElementById("inst-cmd").textContent = job.command;
        renderLog(job.lines);
        if (job.running) {
          setState("run", `安装中…（${job.methodLabel}）`);
        } else {
          clearInterval(pollTimer); pollTimer = null;
          const ok = job.exitCode === 0;
          setState(ok ? "ok" : "err", ok ? "✓ 安装完成" : `✗ 安装失败（退出码 ${job.exitCode}）`);
          const btn = document.getElementById("inst-action");
          btn.style.display = "inline-block";
          btn.textContent = ok ? "完 成" : "关 闭";
          if (ok && opts.onDone) opts.onDone();
        }
      } catch (e) {
        if (++fails > 5) { clearInterval(pollTimer); pollTimer = null; setState("err", "⚠️ 无法获取安装进度"); }
      }
    }, 700);
  }

  async function install(id, opts) {
    opts = opts || {};
    buildDom();
    overlay.classList.add("show");
    document.getElementById("inst-icon").textContent = opts.icon || "📦";
    document.getElementById("inst-name").textContent = `安装 ${opts.name || id}`;
    document.getElementById("inst-cmd").textContent = "正在提交安装任务…";
    document.getElementById("inst-action").style.display = "none";
    renderLog([]);
    setState("run", "提交中…");

    try {
      const res = await api("/api/install", { method: "POST", json: { id } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      poll(data.jobId, opts);
    } catch (e) {
      setState("err", `⚠️ ${e.message}`);
      document.getElementById("inst-action").style.display = "inline-block";
    }
  }

  return { install, close };
})();
