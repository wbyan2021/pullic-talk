import express from "express";
import { readFileSync, watch } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WebSocketServer } from "ws";

import { log } from "./utils/log.js";
import { activeProcs } from "./utils/process-registry.js";
import { AGENTS } from "./config.js";
import { setupTerminal, getActivePtys } from "./terminal.js";
import apiRoutes from "./routes/api.js";
import toolsRoutes from "./routes/tools.js";
import launchRoutes from "./routes/launch.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const app = express();
const PORT = process.env.PORT || 3210;
// 安全: 内嵌终端拥有完整 shell 权限，只允许本机访问
const HOST = process.env.HOST || "127.0.0.1";

// ===== 安全加固 =====
// CSP 头：限制资源来源，防止 XSS
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net https://api.fontshare.com 'unsafe-inline'; " +
    "style-src 'self' https://cdn.jsdelivr.net https://api.fontshare.com 'unsafe-inline'; " +
    "font-src 'self' https://cdn.jsdelivr.net https://api.fontshare.com; " +
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; " +
    "img-src 'self' data:; " +
    "frame-src 'self'"
  );
  next();
});

// 简易速率限制：每 IP 每分钟最多 200 次请求
const _rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60_000;
  const maxReqs = 200;
  let entry = _rateLimitMap.get(ip);
  if (!entry || now - entry.start > windowMs) {
    entry = { start: now, count: 1 };
    _rateLimitMap.set(ip, entry);
  } else {
    entry.count++;
  }
  if (entry.count > maxReqs) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

// 静态文件：CSS / JS / 图片等
// 本地开发面板，禁用浏览器缓存，保证改动后刷新即见最新
app.use(express.static(join(ROOT, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate"),
}));

// JSON 解析错误统一返回友好格式（不泄露堆栈/路径）
app.use((err, req, res, next) => {
  if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "请求体不是合法 JSON" });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "请求体过大" });
  next(err);
});

// ===== 静态 HTML 页面（带热加载缓存） =====
let _htmlCache = readFileSync(join(ROOT, "public", "index.html"), "utf-8");
watch(join(ROOT, "public", "index.html"), () => {
  try {
    _htmlCache = readFileSync(join(ROOT, "public", "index.html"), "utf-8");
    log("✓ index.html reloaded");
  } catch {}
});

let _chatCache = readFileSync(join(ROOT, "public", "chat.html"), "utf-8");
watch(join(ROOT, "public", "chat.html"), () => {
  try {
    _chatCache = readFileSync(join(ROOT, "public", "chat.html"), "utf-8");
    log("✓ chat.html reloaded");
  } catch {}
});

let _termCache = readFileSync(join(ROOT, "public", "terminal.html"), "utf-8");
watch(join(ROOT, "public", "terminal.html"), () => {
  try {
    _termCache = readFileSync(join(ROOT, "public", "terminal.html"), "utf-8");
    log("✓ terminal.html reloaded");
  } catch {}
});

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.send(_htmlCache);
});

app.get("/chat", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.send(_chatCache);
});

app.get("/terminal", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.send(_termCache);
});

// ===== 挂载路由 =====
apiRoutes(app);
toolsRoutes(app);
launchRoutes(app);

// ===== 启动 & 优雅关闭 =====
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  🤖 AI 控制中心已启动（${Object.keys(AGENTS).length} 个 agent）`);
  console.log(`  ────────────────────────────`);
  console.log(`  打开浏览器访问: http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
  console.log(`  安全: 仅监听 ${HOST}\n`);
});

// 将 WebSocket 挂载到同一 HTTP 服务，路径 /ws/terminal
const wss = new WebSocketServer({ server, path: "/ws/terminal", verifyClient: (info, cb) => {
  // WebSocket origin 检查：只允许本机来源
  const origin = info.origin || "";
  const ok = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  cb(ok, ok ? undefined : 403, "Forbidden");
}});
setupTerminal(wss);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ 端口 ${PORT} 已被占用。请关闭占用进程，或用 PORT=xxxx node src/server.js 指定其他端口。\n`);
    process.exit(1);
  }
  throw err;
});

function shutdown() {
  const activePtys = getActivePtys();
  log(`收到退出信号，正在终止 ${activeProcs.size} 个子进程、${activePtys.size} 个终端…`);
  for (const p of activeProcs) { try { p.kill("SIGTERM"); } catch {} }
  for (const t of activePtys) { try { t.kill(); } catch {} }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
