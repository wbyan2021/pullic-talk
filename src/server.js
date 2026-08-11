import express from "express";
import { readFileSync, watch } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { WebSocketServer } from "ws";

import { log } from "./utils/log.js";
import { TOKEN, tokenOk, authGate } from "./utils/auth.js";
import { activeProcs } from "./utils/process-registry.js";
import { AGENTS } from "./config.js";
import { setupTerminal, getActivePtys } from "./terminal.js";
import apiRoutes from "./routes/api.js";
import toolsRoutes from "./routes/tools.js";
import launchRoutes from "./routes/launch.js";
import installRoutes from "./routes/install.js";
import escortRoutes from "./routes/escort.js";
import projectRoutes from "./routes/project.js";
import { createCredentialStore } from "./services/credential-store.js";
import { createDeepSeekProvider } from "./providers/deepseek.js";
import { createEscortService } from "./services/escort-service.js";
import { createGitInspector } from "./services/git-inspector.js";
import { createProjectBoundary } from "./services/project-boundary.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const app = express();
const PORT = process.env.PORT || 3210;
// 安全: 内嵌终端拥有完整 shell 权限，只允许本机访问
const HOST = process.env.HOST || "127.0.0.1";
const credentialStore = createCredentialStore();
const deepSeekProvider = createDeepSeekProvider();
const escortService = createEscortService({ credentialStore, provider: deepSeekProvider });
const projectBoundary = createProjectBoundary({
  inspector: createGitInspector(),
  statePath: join(ROOT, "projects.local.json"),
});

// ===== 安全加固 =====
// CSP 头：第三方库已全部本地化（public/vendor/），不再依赖 CDN。
// 注：script-src 暂保留 'unsafe-inline'（前端仍有 inline onclick），
// 待前端模块化重构（P2）后可移除。
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' https://api.fontshare.com 'unsafe-inline'; " +
    "font-src 'self' https://api.fontshare.com; " +
    "connect-src 'self'; " +
    "img-src 'self' data:; " +
    "frame-src 'self'"
  );
  next();
});

// 简易速率限制：每 IP 每分钟最多 200 次请求
const _rateLimitMap = new Map();
// 定期清理过期条目，防止 Map 无界增长（内存泄漏）
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateLimitMap) {
    if (now - entry.start > 60_000) _rateLimitMap.delete(ip);
  }
}, 60_000).unref();
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
// index: false —— 禁止 static 自动把 public/index.html 响应给 /，
// 否则会绕过下面 serveHtml() 的 token 注入
app.use(express.static(join(ROOT, "public"), {
  index: false,
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

// ===== 静态 HTML 页面（带热加载缓存 + 响应时注入 token） =====
// 页面里的 <!--OPS:TOKEN--> 占位符会在响应时替换为 window.__OPS_TOKEN__，
// 这样 token 不落盘到 public/ 目录，也不进 git。
const TOKEN_SNIPPET = `<script>window.__OPS_TOKEN__=${JSON.stringify(TOKEN)};</script>`;
const injectToken = (html) => html.replace("<!--OPS:TOKEN-->", TOKEN_SNIPPET);

function watchHtml(name) {
  const file = join(ROOT, "public", name);
  let cache = readFileSync(file, "utf-8");
  const watcher = watch(file, () => {
    try {
      cache = readFileSync(file, "utf-8");
      log(`✓ ${name} reloaded`);
    } catch (e) {
      log(`⚠️ ${name} 热加载失败: ${e.message}`);
    }
  });
  watcher.on("error", (e) => log(`⚠️ ${name} watcher 错误: ${e.message}`));
  return () => cache;
}

const getIndexHtml = watchHtml("index.html");
const getChatHtml = watchHtml("chat.html");
const getTermHtml = watchHtml("terminal.html");

function serveHtml(getHtml) {
  return (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.send(injectToken(getHtml()));
  };
}

app.get("/", serveHtml(getIndexHtml));
app.get("/chat", serveHtml(getChatHtml));
app.get("/terminal", serveHtml(getTermHtml));

// ===== 挂载路由 =====
// 认证闸门：除白名单（/api/health）外，所有 /api/* 需携带 token
app.use("/api", authGate);
escortRoutes(app, { escortService });
projectRoutes(app, { projectBoundary });
apiRoutes(app);
toolsRoutes(app);
launchRoutes(app);
installRoutes(app);

// ===== 启动 & 优雅关闭 =====
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  🤖 AI 控制中心已启动（${Object.keys(AGENTS).length} 个 agent）`);
  console.log(`  ────────────────────────────`);
  console.log(`  打开浏览器访问: http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${PORT}`);
  console.log(`  安全: 仅监听 ${HOST}\n`);
});

// 将 WebSocket 挂载到同一 HTTP 服务，路径 /ws/terminal
const wss = new WebSocketServer({
  server,
  path: "/ws/terminal",
  maxPayload: 1024 * 1024, // 单帧上限 1MB，防恶意大消息
  verifyClient: (info, cb) => {
    // 双重校验：origin（挡浏览器跨域）+ token（挡本机其他脚本/CSRF）
    const origin = info.origin || "";
    const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    let token = "";
    try {
      token = new URL(info.req.url, "http://127.0.0.1").searchParams.get("token") || "";
    } catch {}
    const ok = originOk && tokenOk(token);
    cb(ok, ok ? undefined : 403, "Forbidden");
  },
});
setupTerminal(wss);
// WSS 会把 HTTP server 的 error（如 EADDRINUSE）转发为自身 error，
// 没有监听者会 crash 并掩盖下面 server.on("error") 的友好提示
wss.on("error", () => {});

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
