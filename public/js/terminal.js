"use strict";
/* ═══════════════════════════════════════════
   AI·OPS DECK — Terminal page logic
   ═══════════════════════════════════════════ */

const $ = (s, r=document) => r.querySelector(s);

/* ---------- 主题 ---------- */
function applyTheme(t){ document.documentElement.setAttribute("data-theme", t); localStorage.setItem("ops-theme", t); }
applyTheme(localStorage.getItem("ops-theme") || "dark");

/* ---------- 终端配色（与控制台一致） ---------- */
const BASE_FONT = 13;
let fontSize = parseInt(localStorage.getItem("term-font") || BASE_FONT, 10);

function termTheme(){
  return {
    background:"#07090c", foreground:"#d7dee8",
    cursor:"#ff6b35", cursorAccent:"#07090c",
    selectionBackground:"rgba(255,107,53,.28)",
    black:"#2a3140", red:"#ff5f57", green:"#b8f24e", yellow:"#ffd23f", blue:"#7aa2f7",
    magenta:"#b78cff", cyan:"#4ecdc4", white:"#d7dee8",
    brightBlack:"#586174", brightRed:"#ff7a72", brightGreen:"#c9f76a", brightYellow:"#ffdd66",
    brightBlue:"#96b6ff", brightMagenta:"#c9a6ff", brightCyan:"#72e0d8", brightWhite:"#ffffff",
    fontFamily:'"JetBrains Mono", ui-monospace, monospace',
    fontSize, letterSpacing:0, lineHeight:1.18,
    cursorBlink:true, scrollback:8000, allowProposedApi:true,
  };
}

/* ---------- 终端初始化 ---------- */
const term = new window.Terminal(termTheme());
const fit = new window.FitAddon.FitAddon();
term.loadAddon(fit);
if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
term.open($("#term"));

/* ---------- 状态 ---------- */
let ws = null;
let ready = false;
let pid = null;
let startedAt = null;
let pendingRun = null;      // 待执行的命令（来自 ?run=）
let pendingInput = [];      // 连接前缓存的输入

/* 读取 ?run= 参数 */
(function(){
  const q = new URLSearchParams(location.search);
  const run = q.get("run");
  if (run) pendingRun = run;
})();

/* ---------- WebSocket ---------- */
function connect(){
  setConn("connecting");
  showOverlay("connecting");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = encodeURIComponent((window.OPS && OPS.TOKEN) || "");
  ws = new WebSocket(`${proto}://${location.host}/ws/terminal?token=${token}`);

  ws.onopen = () => {
    ready = true;
    startedAt = startedAt || Date.now();
    setConn("connected");
    hideOverlay();
    fit.fit(); sendDims();
    // 冲刷缓存输入
    const buf = pendingInput; pendingInput = [];
    buf.forEach(m => send(m));
    // 注入待执行命令：必须先弹框让用户确认（防恶意链接借 ?run= 执行任意命令）
    if (pendingRun){
      const cmd = pendingRun; pendingRun = null;
      askRunConfirm(cmd);
    }
    term.focus();
  };

  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "output") term.write(m.data);
    else if (m.type === "hello"){
      pid = m.pid;
      $("#pid-badge").textContent = `pid ${m.pid}`;
      $("#shell-badge").textContent = (m.shell || "zsh").split("/").pop();
    }
    else if (m.type === "exit"){
      ready = false;
      setConn("closed");
      showOverlay("ended", m.code);
    }
  };

  ws.onclose = () => {
    ready = false;
    setConn("closed");
    // 自动重连（除非是主动重启流程）
    if (!manualRestart) showOverlay("ended");
  };
  ws.onerror = () => {};
}

let manualRestart = false;
function send(m){
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
  else pendingInput.push(m);
}
function sendDims(){
  send({ type:"resize", cols: term.cols, rows: term.rows });
  $("#dims").textContent = `${term.cols}×${term.rows}`;
}

/* 终端输入 → 服务端 */
term.onData(d => send({ type:"input", data:d }));

/* 尺寸自适应 */
new ResizeObserver(() => { if (ready){ fit.fit(); sendDims(); } }).observe($("#stage"));

/* ---------- ?run= 命令确认 ---------- */
function askRunConfirm(cmd){
  const ov = $("#run-confirm");
  $("#rc-cmd").textContent = cmd;
  ov.classList.add("show");
  const ok = $("#rc-ok"), cancel = $("#rc-cancel");
  const close = () => { ov.classList.remove("show"); ok.onclick = cancel.onclick = null; term.focus(); };
  ok.onclick = () => {
    close();
    send({ type:"run", command: cmd });
    toast(`执行 ${cmd.length > 60 ? cmd.slice(0, 60) + "…" : cmd}`);
  };
  cancel.onclick = close;
}

/* ---------- 覆盖层 ---------- */
function showOverlay(kind, code){
  const ov = $("#overlay");
  const icon = $("#ov-icon"), title = $("#ov-title"), sub = $("#ov-sub"), btn = $("#ov-btn");
  if (kind === "connecting"){
    icon.textContent = "◉"; title.textContent = "正在建立终端会话…";
    sub.textContent = "连接到本地 shell"; btn.style.display = "none";
  } else if (kind === "ended"){
    icon.textContent = "⏻"; title.textContent = "会话已结束";
    sub.textContent = code != null ? `退出码 ${code}` : "连接已断开";
    btn.style.display = "inline-block"; btn.textContent = "重 启 会 话";
  }
  ov.classList.add("show");
}
function hideOverlay(){ $("#overlay").classList.remove("show"); }

/* ---------- 连接状态 ---------- */
function setConn(state){
  $("#conn").dataset.state = state;
  $("#conn-label").textContent = { connected:"已连接", connecting:"连接中", closed:"已断开" }[state] || state;
}

/* ---------- 操作 ---------- */
function restart(){
  manualRestart = true;
  try { send({ type:"reset" }); } catch {}
  setTimeout(() => {
    manualRestart = false;
    term.clear();
    try { ws && ws.close(); } catch {}
    connect();
  }, 250);
}
function clearTerm(){ term.clear(); term.focus(); }

function zoom(dir){
  fontSize = Math.min(24, Math.max(10, fontSize + dir));
  localStorage.setItem("term-font", fontSize);
  term.options.fontSize = fontSize;
  fit.fit(); sendDims();
  toast(`字号 ${fontSize}px`);
}

function copyAll(){
  // 有选中内容复制选中，否则汇总全部滚动缓冲
  let all = "";
  const buf = term.buffer.active;
  for (let i = 0; i <= buf.cursorY + buf.baseY; i++){
    const line = buf.getLine(i);
    if (line) all += line.translateToString(true) + "\n";
  }
  const payload = (term.getSelection() || all).replace(/\n{3,}/g, "\n\n");
  navigator.clipboard.writeText(payload).then(
    () => toast("已复制到剪贴板"),
    () => toast("复制失败", true)
  );
}

/* ---------- 时钟 & 会话时长 ---------- */
function tick(){
  $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12:false });
  if (startedAt){
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const mm = String(Math.floor(s/60)).padStart(2,"0");
    const ss = String(s%60).padStart(2,"0");
    const hh = Math.floor(s/3600);
    $("#uptime").textContent = `⏱ ${hh ? hh + ":" + mm : mm + ":" + ss}`;
  }
}
tick(); setInterval(tick, 1000);

/* ---------- 快捷键 ---------- */
document.addEventListener("keydown", e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k"){ e.preventDefault(); clearTerm(); }
  else if (mod && e.key.toLowerCase() === "r"){ e.preventDefault(); restart(); }
  else if (mod && (e.key === "=" || e.key === "+")){ e.preventDefault(); zoom(1); }
  else if (mod && e.key === "-"){ e.preventDefault(); zoom(-1); }
  else if (mod && e.key === "0"){ e.preventDefault(); fontSize = BASE_FONT; localStorage.setItem("term-font", fontSize); term.options.fontSize = fontSize; fit.fit(); sendDims(); toast(`字号 ${fontSize}px`); }
});

/* 点击终端任意处获取焦点 */
$("#stage").addEventListener("mousedown", () => term.focus());

/* ---------- Toast ---------- */
function toast(msg, err=false){
  const el = document.createElement("div"); el.className = "toast-item";
  el.innerHTML = `<span class="td" style="background:${err ? "#ff5f57" : "var(--lime)"}"></span>${esc(msg)}`;
  $("#toast").appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 2200);
}
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

/* ---------- 启动 ---------- */
fit.fit();
connect();
