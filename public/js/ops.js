"use strict";
/* ═══════════════════════════════════════════
   AI·OPS DECK — 前端共享工具
   （token 由服务端渲染 HTML 时注入 window.__OPS_TOKEN__）
   ═══════════════════════════════════════════ */
window.OPS = (() => {
  const TOKEN = window.__OPS_TOKEN__ || "";

  // 所有敏感 API 请求都要带的 header
  const authHeaders = (extra) => Object.assign({ "x-auth-token": TOKEN }, extra || {});

  // fetch 包装：自动带 token + JSON
  async function api(url, opts) {
    const o = opts || {};
    o.headers = authHeaders(o.headers);
    if (o.json !== undefined) {
      o.headers["Content-Type"] = "application/json";
      o.body = JSON.stringify(o.json);
      delete o.json;
    }
    const res = await fetch(url, o);
    if (res.status === 401) throw new Error("未授权（token 无效，请刷新页面）");
    return res;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  return { TOKEN, authHeaders, api, esc };
})();
