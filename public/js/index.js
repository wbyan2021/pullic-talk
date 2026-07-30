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
    const r = await fetch("/api/tools"); const d = await r.json();
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

function card(t, idx){
  const el = document.createElement("div");
  el.className = "card" + (t.installed?"":" missing");
  el.style.setProperty("--cat", CAT_COLOR[t.category] || "var(--accent)");
  const stat = t.installed
    ? `<span class="stat ok"><span class="d"></span>ready</span>`
    : `<span class="stat"><span class="d"></span>未安装</span>`;
  const qas = (t.quickActions||[]).map((a,i)=>
    `<button class="qa" data-qa="${i}">${esc(a.label)}</button>`).join("");
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
    </div>`;
  $(".launch", el).onclick = () => runAction(t.launch, t);
  $$(".qa", el).forEach(b => b.onclick = () => runAction(t.quickActions[+b.dataset.qa], t));
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
    const r = await fetch("/api/launch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"app",app})});
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
      const r = await fetch("/api/launch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"command",command:action.command})});
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
  state.view = v;
  $$(".tab").forEach(t=>t.classList.toggle("active", t.dataset.view===v));
  $("#console-view").classList.toggle("active", v==="console");
  $("#chat-view").classList.toggle("active", v==="chat");
  if (v==="chat"){ const f=$("#chat-frame"); if(!f.src) f.src = f.dataset.src; }
}

/* ---------- 后台进程 ---------- */
async function refreshProcs(){
  try {
    const r = await fetch("/api/procs"); const list = await r.json();
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
  await fetch("/api/procs/kill",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});
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
    const r = await fetch("/api/tools/scan",{method:"POST"}); const d = await r.json();
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
refreshProcs();
setInterval(refreshProcs, 8000);
setInterval(()=>{ if(state.view==="console") loadTools(); }, 30000); // 定期刷新服务状态
