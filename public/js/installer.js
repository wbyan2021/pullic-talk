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
    let finished = false;
    // 新安装任务先清掉上一个轮询器，避免并发安装时旧定时器重复触发 onDone
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const timer = setInterval(async () => {
      if (finished) return;
      try {
        const res = await api(`/api/install/job/${jobId}`);
        // await 期间可能已有新安装接管了 pollTimer：本次回调不得再动共享定时器/界面
        if (pollTimer !== timer) return;
        if (!res.ok) throw new Error("job fetch failed");
        const job = await res.json();
        fails = 0;
        document.getElementById("inst-cmd").textContent = job.command;
        renderLog(job.lines);
        if (job.running) {
          setState("run", `安装中…（${job.methodLabel}）`);
        } else {
          finished = true;
          clearInterval(timer); pollTimer = null;
          const ok = job.exitCode === 0;
          setState(ok ? "ok" : "err", ok ? "✓ 安装完成" : `✗ 安装失败（退出码 ${job.exitCode}）`);
          const btn = document.getElementById("inst-action");
          btn.style.display = "inline-block";
          btn.textContent = ok ? "完 成" : "关 闭";
          if (ok && opts.onDone) opts.onDone();
        }
      } catch (e) {
        if (++fails > 5) { finished = true; clearInterval(timer); if (pollTimer === timer) pollTimer = null; setState("err", "⚠️ 无法获取安装进度"); }
      }
    }, 700);
  }

  async function install(id, opts) {
    opts = opts || {};
    const verb = opts.action === "update" ? "更新" : "安装";
    buildDom();
    overlay.classList.add("show");
    document.getElementById("inst-icon").textContent = opts.icon || "📦";
    document.getElementById("inst-name").textContent = `${verb} ${opts.name || id}`;
    document.getElementById("inst-cmd").textContent = `正在提交${verb}任务…`;
    document.getElementById("inst-action").style.display = "none";
    renderLog([]);
    setState("run", "提交中…");

    try {
      const res = await api("/api/install", { method: "POST", json: { id, action: opts.action } });
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
