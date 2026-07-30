// ===== 本机认证 =====
// 威胁模型：
//   1. 恶意网页通过浏览器打 127.0.0.1（CSRF / 跨域 fetch）→ 无法读取跨域响应，
//      也无法在不触发 preflight 的情况下设置自定义 header → 被 token 拦死。
//   2. 本机其他进程 → 与运行本服务的用户同权限，属于信任边界内（和终端本身一样）。
//
// 机制：启动时生成随机 token，写入项目根目录 .token（0600，已 gitignore），
// 并由服务端在返回 HTML 时注入 window.__OPS_TOKEN__，前端所有敏感请求携带该 token。
import { randomBytes, timingSafeEqual } from "crypto";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { log } from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

export const TOKEN = randomBytes(24).toString("hex");

try {
  writeFileSync(join(ROOT, ".token"), TOKEN + "\n", { mode: 0o600 });
} catch (e) {
  log(`⚠️ 无法写入 .token 文件: ${e.message}（不影响运行，run-debate.js 将需要手动传 token）`);
}

export function tokenOk(t) {
  if (typeof t !== "string" || t.length !== TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

// Express 中间件：校验 x-auth-token 头（或 Authorization: Bearer）
export function requireAuth(req, res, next) {
  const t = req.get("x-auth-token") || "";
  const bearer = req.get("authorization") || "";
  if (tokenOk(t) || (bearer.startsWith("Bearer ") && tokenOk(bearer.slice(7)))) return next();
  res.status(401).json({ error: "未授权：缺少有效的认证 token" });
}

// 白名单：只读健康检查（run-debate.js 启动前探活用）
// 注：本中间件挂在 app.use("/api", ...) 下，req.path 是去掉 /api 前缀的相对路径
const AUTH_EXEMPT = new Set(["/health"]);

export function authGate(req, res, next) {
  if (AUTH_EXEMPT.has(req.path)) return next();
  return requireAuth(req, res, next);
}
