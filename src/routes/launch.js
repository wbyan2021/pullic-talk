import { spawn } from "child_process";
import { existsSync } from "fs";
import { bgProcs, nextBgId } from "../utils/process-registry.js";
import { log } from "../utils/log.js";

// 危险命令模式：阻止可能造成不可逆损害的操作
// 注意：不要加 \bformat\b 之类的宽泛词 —— 会误杀 npm run format / prettier 等正常命令
// （format 是 Windows cmd 的命令，macOS 上不存在该危险命令）
const DANGEROUS_PATTERNS = [/\brm\s+-rf\b/, /\bmkfs\b/, /\bdd\s+if=/, />\s*\/dev\/(sda|disk)/, /\bdiskutil\s+(erase|partition|apfs\s+delete)/, /\bshutdown\b/, /\breboot\b/];

export default function launchRoutes(app) {
  // 启动: app(打开桌面应用) / command(后台运行命令)
  app.post("/api/launch", (req, res) => {
    const { type, app: appName, command, cwd } = req.body || {};

    if (type === "app") {
      if (typeof appName !== "string" || !appName.trim()) return res.status(400).json({ error: "app 名称不能为空" });
      // 防止以 - 开头的名称被 open 解析为额外参数
      if (appName.trim().startsWith("-")) return res.status(400).json({ error: "app 名称非法" });
      try {
        const p = spawn("open", ["-a", appName.trim()], { stdio: "ignore" });
        p.on("error", (e) => log(`⚠️ 打开 ${appName} 失败: ${e.message}`));
        return res.json({ ok: true, launched: `app:${appName}` });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    if (type === "command") {
      if (typeof command !== "string" || !command.trim()) return res.status(400).json({ error: "command 不能为空" });
      // 安全检查：拦截危险命令
      if (DANGEROUS_PATTERNS.some((p) => p.test(command))) {
        return res.status(403).json({ error: "命令包含危险操作，已被拦截" });
      }
      const shell = process.env.SHELL || "/bin/zsh";
      const workdir = (typeof cwd === "string" && cwd.trim() && existsSync(cwd)) ? cwd : process.env.HOME;
      try {
        const p = spawn(shell, ["-lc", command], {
          cwd: workdir, env: process.env, stdio: "ignore", detached: true,
        });
        p.unref();
        const id = nextBgId();
        bgProcs.set(id, { id, command, pid: p.pid, startedAt: Date.now() });
        p.on("exit", () => bgProcs.delete(id));
        log(`🚀 后台启动 [${id}] ${command} (pid ${p.pid})`);
        return res.json({ ok: true, id, pid: p.pid });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    res.status(400).json({ error: `未知 launch 类型: ${type}` });
  });

  // 查询后台进程
  app.get("/api/procs", (req, res) => {
    res.json([...bgProcs.values()].map(({ id, command, pid, startedAt }) => ({ id, command, pid, startedAt })));
  });

  // 终止后台进程
  app.post("/api/procs/kill", (req, res) => {
    const { id } = req.body || {};
    const rec = bgProcs.get(id);
    if (!rec) return res.status(404).json({ error: "进程不存在或已退出" });
    try { process.kill(-rec.pid, "SIGTERM"); } catch { try { process.kill(rec.pid, "SIGTERM"); } catch {} }
    bgProcs.delete(id);
    res.json({ ok: true, killed: id });
  });
}
