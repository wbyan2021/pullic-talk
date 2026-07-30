import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { INSTALL_CATALOG, getInstallEntry } from "../install-catalog.js";
import { refreshAvailability } from "../config.js";
import { activeProcs } from "../utils/process-registry.js";
import { log } from "../utils/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const JOB_TIMEOUT_MS = 20 * 60_000; // brew 编译可能很慢
const MAX_LINES = 3000;

// ===== 环境探测（缓存）=====
let _brewPath = undefined;
function brewAvailable() {
  if (_brewPath === undefined) {
    try {
      const r = spawnSync("/usr/bin/which", ["brew"], { encoding: "utf-8", timeout: 3000 });
      _brewPath = r.status === 0 ? r.stdout.trim() : null;
    } catch {
      _brewPath = null;
    }
  }
  return !!_brewPath;
}

function isInstalled(entry) {
  const det = entry.detect || {};
  for (const cmd of det.commands || []) {
    try {
      const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf-8", timeout: 3000 });
      if (r.status === 0 && r.stdout.trim()) return true;
    } catch {}
  }
  for (const app of det.apps || []) {
    if (existsSync(join("/Applications", app))) return true;
    if (process.env.HOME && existsSync(join(process.env.HOME, "Applications", app))) return true;
  }
  return false;
}

// 选择安装方式：brew cask > brew > npm > dmg > 自定义脚本
function pickMethod(entry) {
  if (entry.script) return { method: "script", label: "官方脚本", command: entry.script };
  if (entry.brewCask && brewAvailable()) return { method: "brew", label: "brew cask", command: `brew install --cask ${entry.brewCask}` };
  if (entry.brew && brewAvailable()) return { method: "brew", label: "brew", command: `brew install ${entry.brew}` };
  if (entry.npm) return { method: "npm", label: "npm -g", command: `npm install -g ${entry.npm}` };
  if (entry.dmg) {
    const file = entry.dmg.file || `${entry.id}.dmg`;
    return {
      method: "dmg", label: "官网下载",
      command: `cd ~/Downloads && curl -fL --retry 3 --progress-bar -o ${JSON.stringify(file)} ${JSON.stringify(entry.dmg.url)} && open ${JSON.stringify(file)}`,
    };
  }
  return null;
}

// ===== 任务注册表 =====
const jobs = new Map(); // jobId -> job
let jobSeq = 1;

function startJob(entry) {
  const picked = pickMethod(entry);
  if (!picked) return { error: "该条目没有可用的自动安装方式，请访问官网手动下载" };

  // 同一应用已有任务在跑 → 直接复用
  for (const job of jobs.values()) {
    if (job.appId === entry.id && job.running) return { jobId: job.id, reused: true };
  }

  const id = `inst${jobSeq++}`;
  const job = {
    id, appId: entry.id, appName: entry.name,
    method: picked.method, methodLabel: picked.label,
    command: picked.command,
    pid: null, running: true, exitCode: null,
    startedAt: Date.now(), finishedAt: null,
    lines: [],
  };
  jobs.set(id, job);

  const pushLine = (s) => {
    for (const line of s.split("\n")) {
      if (line.trim() === "" && job.lines.length > 0 && job.lines[job.lines.length - 1] === "") continue;
      job.lines.push(line);
    }
    if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
  };

  log(`📦 开始安装 ${entry.name} [${id}] (${picked.label}): ${picked.command}`);
  pushLine(`$ ${picked.command}`);

  const proc = spawn("/bin/zsh", ["-lc", picked.command], {
    cwd: process.env.HOME, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = proc.pid;
  activeProcs.add(proc);

  const killer = setTimeout(() => {
    pushLine(`\n⏰ 安装超时（${JOB_TIMEOUT_MS / 60000} 分钟），已终止`);
    try { proc.kill("SIGTERM"); } catch {}
  }, JOB_TIMEOUT_MS);

  proc.stdout.on("data", (d) => pushLine(d.toString()));
  proc.stderr.on("data", (d) => pushLine(d.toString()));

  proc.on("close", (code) => {
    clearTimeout(killer);
    activeProcs.delete(proc);
    job.running = false;
    job.exitCode = code;
    job.finishedAt = Date.now();
    if (code === 0) {
      pushLine(`\n✅ ${entry.name} 安装完成`);
      log(`📦 ✓ ${entry.name} 安装完成 [${id}]`);
      // 安装成功：刷新 agent 可用性 + 后台重扫工具清单
      try { refreshAvailability(); } catch {}
      const scan = spawn("node", [join(ROOT, "scripts", "scan-tools.js")], { cwd: ROOT, stdio: "ignore" });
      scan.on("error", () => {});
    } else {
      pushLine(`\n❌ 安装失败（退出码 ${code}）`);
      log(`📦 ✗ ${entry.name} 安装失败 code=${code} [${id}]`);
    }
    // 30 分钟后清理任务记录
    setTimeout(() => jobs.delete(id), 30 * 60_000).unref();
  });

  proc.on("error", (err) => {
    clearTimeout(killer);
    activeProcs.delete(proc);
    job.running = false;
    job.exitCode = -1;
    job.finishedAt = Date.now();
    pushLine(`\n❌ 无法启动安装进程: ${err.message}`);
  });

  return { jobId: id };
}

export default function installRoutes(app) {
  // 安装目录（含已安装状态 + 推荐安装方式）
  app.get("/api/install/catalog", (req, res) => {
    const entries = INSTALL_CATALOG.map((e) => {
      const installed = isInstalled(e);
      const picked = pickMethod(e);
      return {
        id: e.id, name: e.name, kind: e.kind, group: e.group,
        icon: e.icon, color: e.color, description: e.description, homepage: e.homepage,
        agentKey: e.agentKey || null,
        installed,
        method: installed ? null : (picked ? picked.method : "manual"),
        methodLabel: installed ? null : (picked ? picked.label : "手动"),
      };
    });
    res.json({ brewAvailable: brewAvailable(), entries });
  });

  // 发起安装（白名单 id，命令只来自目录常量，不接受任意用户输入）
  app.post("/api/install", (req, res) => {
    const { id } = req.body || {};
    const entry = getInstallEntry(id);
    if (!entry) return res.status(400).json({ error: `未知安装条目: ${id}` });
    if (isInstalled(entry)) return res.status(400).json({ error: `${entry.name} 已经安装` });
    const result = startJob(entry);
    if (result.error) return res.status(400).json(result);
    res.json({ ok: true, ...result });
  });

  // 查询任务（前端轮询日志）
  app.get("/api/install/job/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "任务不存在或已清理" });
    res.json({
      id: job.id, appId: job.appId, appName: job.appName,
      method: job.method, methodLabel: job.methodLabel, command: job.command,
      running: job.running, exitCode: job.exitCode,
      startedAt: job.startedAt, finishedAt: job.finishedAt,
      lines: job.lines,
    });
  });
}
