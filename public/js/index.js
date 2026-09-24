"use strict";
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const CATS = { agent:"编码 Agent", model:"本地模型", chat:"对话 App", editor:"编辑器", utility:"开发工具" };
const CAT_COLOR = { agent:"var(--c-agent)", model:"var(--c-model)", chat:"var(--c-chat)", editor:"var(--c-editor)", utility:"var(--c-utility)" };
const CAT_ORDER = ["agent","model","chat","editor","utility"];

const state = { tools:[], services:{}, filter:"all", query:"", view:"console" };

/* ---------- 主题 ---------- */
function applyTheme(t){ document.documentElement.setAttribute("data-theme", t); localStorage.setItem("ops-theme", t); }
function toggleTheme(){ applyTheme(document.documentElement.getAttribute("data-theme")==="dark" ? "light":"dark"); }
applyTheme(localStorage.getItem("ops-theme") || "dark");

/* ---------- 时钟 ---------- */
function tick(){ $("#clock").textContent = new Date().toLocaleTimeString("zh-CN",{hour12:false}); }
tick(); setInterval(tick, 1000);

/* ---------- 数据加载 ---------- */
async function loadTools(){
  try {
    const r = await OPS.api("/api/tools"); const d = await r.json();
    state.tools = d.tools || []; state.services = d.services || {};
    renderLeds(); renderFilters(); renderGrid();
  } catch(e){ toast("加载工具失败: "+e.message, true); }
}

function renderLeds(){
  const el = $("#leds"); el.innerHTML = "";
  for (const [name, s] of Object.entries(state.services)){
    const d = document.createElement("div");
    d.className = "led" + (s.online ? " on":"");
    d.innerHTML = `<span class="dot"></span>${name} :${s.port}`;
    el.appendChild(d);
  }
}

function renderFilters(){
  const el = $("#filters"); el.innerHTML = "";
  const counts = {};
  for (const t of state.tools) if (t.installed) counts[t.category]=(counts[t.category]||0)+1;
  const mk = (key,label,n,color) => {
    const c = document.createElement("button");
    c.className = "chip" + (state.filter===key?" active":"");
    c.innerHTML = (color?`<span class="cdot" style="background:${color}"></span>`:"") + label + ` <span class="n">${n}</span>`;
    c.onclick = () => { state.filter = state.filter===key?"all":key; renderFilters(); renderGrid(); };
    return c;
  };
  el.appendChild(mk("all","全部", state.tools.filter(t=>t.installed).length));
  for (const cat of CAT_ORDER) if (counts[cat]) el.appendChild(mk(cat, CATS[cat], counts[cat], CAT_COLOR[cat]));
}

function match(t){
  if (state.filter!=="all" && t.category!==state.filter) return false;
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return [t.name,t.id,t.description,(t.tags||[]).join(" "),t.path||""].join(" ").toLowerCase().includes(q);
}

function renderGrid(){
  const pad = $("#launchpad"); pad.innerHTML = "";
  let shown = 0, idx = 0;
  for (const cat of CAT_ORDER){
    const items = state.tools.filter(t => t.category===cat && match(t));
    if (!items.length) continue;
    // 已安装排前
    items.sort((a,b)=> (b.installed?1:0)-(a.installed?1:0) || a.name.localeCompare(b.name));
    shown += items.length;
    const sec = document.createElement("div"); sec.className = "cat-section";
    sec.innerHTML = `<div class="cat-head">
        <span class="tick" style="background:${CAT_COLOR[cat]}"></span>
        <span class="label">${CATS[cat]}</span>
        <span class="count">${items.length}</span>
        <span class="rule"></span>
      </div><div class="grid"></div>`;
    const grid = $(".grid", sec);
    for (const t of items) grid.appendChild(card(t, ++idx));
    pad.appendChild(sec);
  }
  $("#empty").style.display = shown ? "none":"block";
}

// 控制台卡片是否可卸载：需要后端注入的 installId 且安装目录标记 canUninstall
function uninstallableTool(t){
  if (!t.installed || !t.installId) return false;
  const e = installEntries.find(x => x.id === t.installId);
  return !!(e && e.canUninstall);
}

function card(t, idx){
  const el = document.createElement("div");
  el.className = "card" + (t.installed?"":" missing");
  el.style.setProperty("--cat", CAT_COLOR[t.category] || "var(--accent)");
  const stat = t.installed
    ? `<span class="stat ok"><span class="d"></span>ready</span>`
    : `<span class="stat"><span class="d"></span>未安装</span>`;
  const qas = (t.quickActions||[]).map((a,i)=>
    `<button class="qa" data-qa="${i}">${esc(a.label)}</button>`).join("");
  const canDel = uninstallableTool(t);
  const delArmed = canDel && uninstallArmed === t.installId;
  el.innerHTML = `
    <div class="top"><span class="idx">${String(idx).padStart(2,"0")}</span>${stat}</div>
    <div class="idrow">
      <div class="tile">${esc(t.icon||"◆")}</div>
      <div class="meta"><div class="nm">${esc(t.name)}</div><div class="tag">${esc(t.category)}</div></div>
    </div>
    <div class="desc">${esc(t.description||"")}</div>
    ${t.path?`<div class="path">${esc(t.path)}</div>`:""}
    <div class="actions">
      <button class="launch">▶ 启动</button>
      ${qas}
      ${canDel?`<button class="card-del${delArmed?" armed":""}" title="${delArmed?"再点一次确认卸载":"卸载"}">${delArmed?"确认卸载?":"🗑"}</button>`:""}
    </div>`;
  $(".launch", el).onclick = () => runAction(t.launch, t);
  $$(".qa", el).forEach(b => b.onclick = () => runAction(t.quickActions[+b.dataset.qa], t));
  const del = $(".card-del", el);
  if (del) del.onclick = () => requestUninstall(t.installId, t.name, t.icon, renderGrid);
  return el;
}

function esc(s){ return String(s).replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- 启动逻辑 ---------- */
async function runAction(action, tool){
  if (!action) return;
  // URL → 浏览器打开
  if (action.url){ window.open(action.url, "_blank"); toast(`打开 ${action.url}`); return; }
  // 桌面 App
  if (action.type==="app" || action.app){
    const app = action.app;
    const r = await OPS.api("/api/launch",{method:"POST",json:{type:"app",app}});
    const d = await r.json();
    if (d.ok) toast(`启动 ${app}`); else toast("失败: "+(d.error||""), true);
    return;
  }
  // 命令
  if (action.command){
    // 若已有 openUrl 且服务已经在监听：跳过启动，直接开浏览器
    if (action.openUrl){
      const alive = await isUrlAlive(action.openUrl);
      if (alive){
        window.open(action.openUrl, "_blank");
        toast(`已在运行，打开 ${action.openUrl}`);
        return;
      }
    }
    if (action.background){
      const r = await OPS.api("/api/launch",{method:"POST",json:{type:"command",command:action.command}});
      const d = await r.json();
      if (d.ok){ toast(`后台运行 ${action.command}`); refreshProcs(); } else toast("失败: "+(d.error||""), true);
      if (action.openUrl) setTimeout(()=>window.open(action.openUrl,"_blank"), action.openDelay||2000);
      return;
    }
    // 跳转全屏终端并注入命令
    openTerminal(action.command);
    if (action.openUrl) setTimeout(()=>window.open(action.openUrl,"_blank"), action.openDelay||2500);
    toast(`在终端执行 ${action.command}`);
  }
}

/* ---------- 端口探活（no-cors，能连通即算 alive） ---------- */
async function isUrlAlive(url, timeout=800){
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), timeout);
    await fetch(url, { mode:"no-cors", signal: ctrl.signal, cache:"no-store" });
    clearTimeout(t);
    return true;
  } catch { return false; }
}

/* ---------- 全屏终端 ---------- */
function openTerminal(command){
  const url = command ? `/terminal?run=${encodeURIComponent(command)}` : "/terminal";
  window.open(url, "_blank");
}

/* ---------- 视图切换 ---------- */
function switchView(v){
  const previousView = state.view;
  state.view = v;
  $$(".tab").forEach(t=>t.classList.toggle("active", t.dataset.view===v));
  $("#console-view").classList.toggle("active", v==="console");
  $("#install-view").classList.toggle("active", v==="install");
  $("#chat-view").classList.toggle("active", v==="chat");
  $("#project-view").classList.toggle("active", v==="project");
  $("#overview-view").classList.toggle("active", v==="overview");
  if (previousView === "overview" && v !== "overview" && typeof window.Overview?.deactivate === "function") window.Overview.deactivate();
  if (v === "overview" && typeof window.Overview?.activate === "function") window.Overview.activate();
  if (v==="install") loadInstallCatalog();
  if (v==="chat"){ const f=$("#chat-frame"); if(!f.src) f.src = f.dataset.src; }
}

/* ---------- 快捷安装 ---------- */
let installEntries = [];
let updateMap = new Map(); // id -> { installed, version, updateAvailable, latest }
let installFilter = "all"; // all | installed | updates | missing

// 当前筛选下条目是否可见（「已安装」即集中管理视图：更新/卸载都在一个列表）
function visibleInstallEntry(e){
  if (installFilter === "installed") return e.installed;
  if (installFilter === "updates") return e.installed && !!(updateMap.get(e.id) && updateMap.get(e.id).updateAvailable);
  if (installFilter === "missing") return !e.installed;
  return true;
}

function renderInstallFilter(){
  const wrap = $("#inst-filter");
  if (!wrap) return;
  const installed = installEntries.filter(e=>e.installed);
  const updates = installed.filter(e=>updateMap.get(e.id) && updateMap.get(e.id).updateAvailable);
  const chips = [
    ["all", "全部", installEntries.length],
    ["installed", "已安装", installed.length],
    ["updates", "可更新", updates.length],
    ["missing", "未安装", installEntries.length - installed.length],
  ];
  wrap.innerHTML = "";
  for (const [key, label, count] of chips){
    const c = document.createElement("button");
    c.className = "ifchip" + (installFilter === key ? " active" : "");
    c.textContent = `${label} ${count}`;
    c.onclick = () => { installFilter = key; renderInstallFilter(); renderInstallGrid(); };
    wrap.appendChild(c);
  }
}

async function loadInstallCatalog(){
  try {
    const r = await OPS.api("/api/install/catalog");
    const d = await r.json();
    installEntries = d.entries || [];
    $("#brew-warn").style.display = d.brewAvailable ? "none" : "block";
    renderStarter(d.starter);
    renderInstallFilter();
    renderInstallGrid();
    loadUpdates();
  } catch(e){ toast("加载安装目录失败: "+e.message, true); }
}

async function loadUpdates(){
  try {
    const r = await OPS.api("/api/install/updates");
    const d = await r.json();
    updateMap = new Map((d.entries || []).map(e => [e.id, e]));
    renderInstallFilter();
    renderInstallGrid();
  } catch(e){ /* 扫描失败不阻塞安装页，卡片退回「已安装」态 */ }
}

const INST_GROUPS = { env:"🧱 基础环境（新手从这里开始）", cli:"⌨️ 编码 / Agent CLI（装完自动进群聊）", editor:"📝 AI 编辑器 / 终端", chat:"💬 AI 对话应用", runtime:"🧰 本地模型运行时", models:"🌐 热门大模型官网" };

function renderStarter(ids){
  const wrap = $("#inst-starter");
  wrap.innerHTML = "";
  const items = (ids || []).map(id => installEntries.find(e => e.id === id)).filter(Boolean);
  if (!items.length) { wrap.style.display = "none"; return; }
  const tt = document.createElement("span");
  tt.className = "schip-tt";
  tt.textContent = "🚀 新手推荐顺序";
  wrap.appendChild(tt);
  for (const e of items){
    const chip = document.createElement("button");
    chip.className = "schip" + (e.installed ? " done" : "");
    chip.style.setProperty("--ic", e.color || "#8a93a3");
    chip.title = e.installed ? `${e.name} 已安装` : `安装 ${e.name}`;
    chip.textContent = e.installed ? `✓ ${e.name}` : `${e.icon || "◆"} ${e.name}`;
    chip.onclick = () => { if (e.installed) toast(`${e.name} 已经安装`, false); else installEntry(e); };
    wrap.appendChild(chip);
  }
  wrap.style.display = "flex";
}

function renderInstallGrid(){
  const wrap = $("#install-grid");
  wrap.innerHTML = "";
  let shown = 0;
  for (const [group, title] of Object.entries(INST_GROUPS)){
    const items = installEntries.filter(e=>e.group===group && visibleInstallEntry(e));
    if (!items.length) continue;
    shown += items.length;
    const sec = document.createElement("div");
    sec.className = "inst-section";
    sec.innerHTML = `<div class="inst-sec-tt">${title}</div><div class="inst-cards"></div>`;
    const cards = $(".inst-cards", sec);
    for (const e of items) cards.appendChild(installCard(e));
    wrap.appendChild(sec);
  }
  if (!shown){
    const empty = document.createElement("div");
    empty.className = "inst-empty";
    empty.textContent = installFilter === "updates" ? "✓ 没有需要更新的工具" : "该筛选下暂无条目";
    wrap.appendChild(empty);
  }
}

  // 统一卸载入口（安装页卡片 / 控制台卡片共用）：双击确认，3 秒未确认自动回退
  let uninstallArmed = null;
  let uninstallTimer = null;

  function requestUninstall(id, name, icon, rerender){
    if (uninstallArmed !== id) {
      uninstallArmed = id;
      rerender();
      clearTimeout(uninstallTimer);
      uninstallTimer = setTimeout(() => { if (uninstallArmed === id) { uninstallArmed = null; rerender(); } }, 3000);
      return;
    }
    uninstallArmed = null;
    clearTimeout(uninstallTimer);
    Installer.install(id, {
      action: "uninstall",
      name, icon,
      onDone: () => {
        loadInstallCatalog(); loadUpdates(); loadTools();
        setTimeout(loadTools, 2500); // 卸载成功后后台重扫 tools.json 需几秒，延迟再刷一次
        toast(`${name} 已卸载`);
      },
    });
  }

  function installCard(e){
    const el = document.createElement("div");
    el.className = "inst-card-item" + (e.installed ? " installed" : "");
    el.style.setProperty("--ic", e.color || "#8a93a3");
    const isLink = e.method === "manual" || e.method === "link";
    const u = updateMap.get(e.id);
    const verText = u && u.version ? ` · v${u.version}` : "";
    const right = e.installed
      ? (u && u.updateAvailable
        ? `<button class="inst-go inst-up" data-update="1" title="${u.latest ? `当前 v${u.version || "?"}，最新 v${u.latest}` : "有可用更新"}">↑ 更新${u.latest ? ` → v${u.latest}` : ""}</button>`
        : `<span class="inst-done">✓ 已安装${verText}</span>`)
      : (isLink
          ? `<button class="inst-go" data-home="1">官网 ↗</button>`
          : `<button class="inst-go" data-install="1">⬇ 安装</button>`);
    el.innerHTML = `
      <span class="ici-icon">${esc(e.icon||"◆")}</span>
      <div class="ici-meta">
        <div class="ici-name">${esc(e.name)}${e.agentKey?` <span class="ici-chat" title="安装后可加入 AI 群聊">◧</span>`:""}</div>
        <div class="ici-desc">${esc(e.description||"")}</div>
        <div class="ici-method">${e.installed ? (u && u.version ? esc("v"+u.version) : "") : esc(e.methodLabel||"")}</div>
      </div>
      ${right}`;
    const go = $(".inst-go", el);
    if (go){
      go.onclick = () => {
        if (go.dataset.home) { window.open(e.homepage, "_blank"); return; }
        installEntry(e, go.dataset.update ? "update" : undefined);
      };
    }
    return el;
  }

function installEntry(e, action){
  const updating = action === "update";
  Installer.install(e.id, {
    action: updating ? "update" : undefined,
    name: e.name, icon: e.icon,
    onDone: () => { loadInstallCatalog(); loadUpdates(); loadTools(); toast(`${e.name} ${updating ? "更新" : "安装"}完成，工具列表已刷新`); },
  });
}

// 供 HTML inline 调用（brew-warn 按钮）
function installById(id){
  const e = installEntries.find(x=>x.id===id);
  if (e) installEntry(e); else loadInstallCatalog().then(()=>{ const x = installEntries.find(y=>y.id===id); if (x) installEntry(x); });
}

/* ---------- 后台进程 ---------- */
async function refreshProcs(){
  try {
    const r = await OPS.api("/api/procs"); const list = await r.json();
    $("#procs-btn").classList.toggle("hide", list.length===0);
    $("#procs-badge").textContent = list.length;
    const pl = $("#plist");
    pl.innerHTML = list.length ? list.map(p=>`
      <div class="proc-row">
        <span class="pc" title="${esc(p.command)}">${esc(p.command)}</span>
        <span class="pid">${p.pid}</span>
        <button class="kill" onclick="killProc('${p.id}')" title="终止">✕</button>
      </div>`).join("") : `<div class="pempty">暂无后台进程</div>`;
  } catch{}
}
async function killProc(id){
  await OPS.api("/api/procs/kill",{method:"POST",json:{id}});
  toast("已终止 "+id); refreshProcs();
}
function togglePopover(e){ e.stopPropagation(); $("#popover").classList.toggle("show"); refreshProcs(); }
document.addEventListener("click", e=>{ if(!$("#popover").contains(e.target) && e.target.id!=="procs-btn") $("#popover").classList.remove("show"); });

/* ---------- 扫描 ---------- */
async function rescan(){
  const b = $("#scan-btn"); const mb = $("#scan-main-btn");
  b && b.classList.add("spin"); mb && mb.classList.add("spin");
  toast("正在扫描本机工具…");
  try {
    const r = await OPS.api("/api/tools/scan",{method:"POST"}); const d = await r.json();
    if (!d.ok) throw new Error(d.error||"扫描失败");
    await loadTools(); toast("扫描完成");
  } catch(e){ toast("扫描失败: "+e.message, true); }
  finally { b && b.classList.remove("spin"); mb && mb.classList.remove("spin"); }
}

/* ---------- Toast ---------- */
function toast(msg, err=false){
  const el = document.createElement("div"); el.className = "toast-item";
  el.innerHTML = `<span class="td" style="background:${err?"#ff5f57":"var(--lime)"}"></span>${esc(msg)}`;
  $("#toast").appendChild(el);
  requestAnimationFrame(()=>el.classList.add("show"));
  setTimeout(()=>{ el.classList.remove("show"); setTimeout(()=>el.remove(), 300); }, 2600);
}

/* ---------- 搜索 & 快捷键 ---------- */
$("#search-input").addEventListener("input", e=>{ state.query = e.target.value.trim(); renderGrid(); });
document.addEventListener("keydown", e=>{
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "");
  if (e.key==="/" && !typing){ e.preventDefault(); $("#search-input").focus(); }
  else if (e.key==="`" && !typing){ e.preventDefault(); openTerminal(); }
  else if (e.key==="Escape"){ if(typing){ document.activeElement?.blur(); state.query=""; $("#search-input").value=""; renderGrid(); } $("#popover").classList.remove("show"); }
});

/* ---------- 启动 ---------- */
loadTools();
loadInstallCatalog(); // 控制台卡片卸载按钮需要安装目录的 canUninstall 信息
refreshProcs();
setInterval(refreshProcs, 8000);
setInterval(()=>{ if(state.view==="console") loadTools(); }, 30000); // 定期刷新服务状态

// 支持从群聊页跳转过来直接开装：/?install=cursor
(function(){
  const id = new URLSearchParams(location.search).get("install");
  if (!id) return;
  switchView("install");
  loadInstallCatalog().then(()=>{
    const e = installEntries.find(x=>x.id===id);
    if (e && !e.installed) installEntry(e);
    else if (e && e.installed) toast(`${e.name} 已经安装`, false);
  });
  history.replaceState(null, "", "/");
})();
