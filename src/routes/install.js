import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { INSTALL_CATALOG, STARTER_PATH, getInstallEntry } from "../install-catalog.js";
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

function brewPath() {
  brewAvailable();
  return _brewPath;
}

// npm -g / brew 的全局 bin 前缀（缓存）：which 找不到时兜底判断
//「已安装但不在服务进程 PATH」的情况（常见于 nvm / 自定义前缀用户）
let _npmBinDir = undefined;
function npmBinDir() {
  if (_npmBinDir === undefined) {
    try {
      const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf-8", timeout: 10_000 });
      _npmBinDir = r.status === 0 && r.stdout.trim() ? join(r.stdout.trim(), "bin") : null;
    } catch {
      _npmBinDir = null;
    }
  }
  return _npmBinDir;
}

let _brewBinDir = undefined;
function brewBinDir() {
  if (!brewAvailable()) return null;
  if (_brewBinDir === undefined) {
    try {
      const r = spawnSync(_brewPath, ["--prefix"], { encoding: "utf-8", timeout: 10_000 });
      _brewBinDir = r.status === 0 && r.stdout.trim() ? join(r.stdout.trim(), "bin") : null;
    } catch {
      _brewBinDir = null;
    }
  }
  return _brewBinDir;
}

function isInstalled(entry) {
  const det = entry.detect || {};
  const cmds = det.commands || [];
  for (const cmd of cmds) {
    try {
      const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf-8", timeout: 3000 });
      if (r.status === 0 && r.stdout.trim()) return true;
    } catch {}
  }
  if (cmds.length) {
    for (const dir of [npmBinDir(), brewBinDir()]) {
      if (dir && existsSync(join(dir, cmds[0]))) return true;
    }
  }
  for (const app of det.apps || []) {
    if (existsSync(join("/Applications", app))) return true;
    if (process.env.HOME && existsSync(join(process.env.HOME, "Applications", app))) return true;
  }
  return false;
}

// 选择安装方式：官方脚本 > brew cask > brew > npm > dmg
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

// 更新方式与安装同源（命令仍只来自目录常量）：brew upgrade / npm @latest / 官方脚本重跑
function pickUpdateMethod(entry) {
  if (entry.script) return { method: "script", label: "官方脚本", command: entry.script };
  if (entry.brewCask && brewAvailable()) return { method: "brew", label: "brew cask", command: `brew upgrade --cask ${entry.brewCask}` };
  if (entry.brew && brewAvailable()) return { method: "brew", label: "brew", command: `brew upgrade ${entry.brew}` };
  if (entry.npm) return { method: "npm", label: "npm -g", command: `npm install -g ${entry.npm}@latest` };
  return null;
}

// 卸载方式：CLI 按实际所属包管理器（npm 装的走 npm，brew 装的走 brew，避免卸错报错）；
// 桌面应用走 cask。脚本安装的（brew/uv/openclaw 等）没有统一卸载渠道，返回 null 由前端隐藏按钮。
function pickUninstallMethod(entry) {
  const cmd = (entry.detect?.commands || [])[0];
  if (cmd) {
    const npmDir = npmBinDir();
    if (entry.npm && npmDir && existsSync(join(npmDir, cmd))) {
      return { method: "npm", label: "npm -g", command: `npm uninstall -g ${entry.npm}` };
    }
    const brewDir = brewBinDir();
    if (brewDir && existsSync(join(brewDir, cmd))) {
      if (entry.brewCask) return { method: "brew", label: "brew cask", command: `brew uninstall --cask ${entry.brewCask}` };
      if (entry.brew) return { method: "brew", label: "brew", command: `brew uninstall ${entry.brew}` };
    }
  }
  if (entry.brewCask && brewAvailable()) return { method: "brew", label: "brew cask", command: `brew uninstall --cask ${entry.brewCask}` };
  if (entry.brew && brewAvailable()) return { method: "brew", label: "brew", command: `brew uninstall ${entry.brew}` };
  if (entry.npm) return { method: "npm", label: "npm -g", command: `npm uninstall -g ${entry.npm}` };
  return null;
}

// 驾驶舱自身运行的基础环境：禁止卸载（服务跑在 node 上、项目识别依赖 git、安装链路依赖 brew）
const PROTECTED_UNINSTALL = new Set(["node", "homebrew", "git"]);

// ===== 任务注册表 =====
const jobs = new Map(); // jobId -> job
let jobSeq = 1;

function startJob(entry, opts = {}) {
  const action = opts.action || (opts.update ? "update" : "install");
  const picked = action === "update" ? pickUpdateMethod(entry)
    : action === "uninstall" ? pickUninstallMethod(entry)
    : pickMethod(entry);
  if (!picked) {
    return { error: action === "update"
      ? "该条目没有可用的自动更新方式，请到官网手动更新"
      : action === "uninstall"
      ? "该条目没有可用的自动卸载方式，请手动卸载"
      : "该条目没有可用的自动安装方式，请访问官网手动下载" };
  }
  const verb = action === "update" ? "更新" : action === "uninstall" ? "卸载" : "安装";

  // 同一应用已有任务在跑 → 直接复用
  for (const job of jobs.values()) {
    if (job.appId === entry.id && job.running) return { jobId: job.id, reused: true };
  }

  const id = `inst${jobSeq++}`;
  const job = {
    id, appId: entry.id, appName: entry.name,
    action,
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

  log(`📦 开始${verb} ${entry.name} [${id}] (${picked.label}): ${picked.command}`);
  pushLine(`$ ${picked.command}`);

  const proc = spawn("/bin/zsh", ["-lc", picked.command], {
    cwd: process.env.HOME, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  job.pid = proc.pid;
  activeProcs.add(proc);

  const killer = setTimeout(() => {
    pushLine(`\n⏰ ${verb}超时（${JOB_TIMEOUT_MS / 60000} 分钟），已终止`);
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
      pushLine(`\n✅ ${entry.name} ${verb}完成`);
      log(`📦 ✓ ${entry.name} ${verb}完成 [${id}]`);
      // 成功：刷新 agent 可用性 + 后台重扫工具清单
      try { refreshAvailability(); } catch {}
      const scan = spawn("node", [join(ROOT, "scripts", "scan-tools.js")], { cwd: ROOT, stdio: "ignore" });
      scan.on("error", () => {});
      // 让下一次更新扫描拿到新版本
      _updatesCache = { at: 0, data: null, promise: null };
    } else {
      pushLine(`\n❌ ${verb}失败（退出码 ${code}）`);
      log(`📦 ✗ ${entry.name} ${verb}失败 code=${code} [${id}]`);
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
    pushLine(`\n❌ 无法启动${verb}进程: ${err.message}`);
  });

  return { jobId: id };
}

// ===== 版本 / 更新扫描 =====
// 数据源：brew outdated --json=v2 与 npm outdated -g --json（只读查询，不改任何包）
const UPDATES_TTL_MS = 60_000;
let _updatesCache = { at: 0, data: null, promise: null };

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    try {
      const p = spawn(cmd, args, { cwd: process.env.HOME, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let killed = false;
      const t = setTimeout(() => { killed = true; try { p.kill("SIGKILL"); } catch {} }, timeoutMs);
      p.stdout.on("data", (d) => chunks.push(d));
      p.on("error", () => { clearTimeout(t); resolve({ code: -1, out: Buffer.concat(chunks).toString() }); });
      p.on("close", (code) => { clearTimeout(t); resolve({ code: killed ? -1 : code, out: Buffer.concat(chunks).toString() }); });
    } catch {
      resolve({ code: -1, out: "" });
    }
  });
}

function parseVersion(text) {
  const m = (text || "").match(/v?(\d+(?:\.\d+)+[A-Za-z0-9.-]*)/);
  return m ? m[1] : null;
}

async function scanCliVersion(cmd, flag) {
  const { out } = await runCapture(cmd, [flag], 5000);
  return parseVersion(out.split("\n").find((l) => l.trim()));
}

async function collectUpdates() {
  const [brewOut, npmOut] = await Promise.all([
    brewPath() ? runCapture(brewPath(), ["outdated", "--json=v2"], 90_000) : Promise.resolve({ code: -1, out: "" }),
    runCapture("npm", ["outdated", "-g", "--json"], 90_000),
  ]);
  // npm outdated 在有过期包时退出码为 1，属正常；解析不到就当作全部最新
  const npmLatest = {};
  try {
    for (const [pkg, info] of Object.entries(JSON.parse(npmOut.out || "{}"))) {
      npmLatest[pkg] = info && info.latest ? info.latest : null;
    }
  } catch {}
  const brewLatest = {};
  try {
    const j = JSON.parse(brewOut.out || "{}");
    for (const row of [...(j.formulae || []), ...(j.casks || [])]) {
      brewLatest[row.name] = Array.isArray(row.current_version) ? (row.current_version[0] || null) : (row.current_version || null);
    }
  } catch {}

  const entries = await Promise.all(INSTALL_CATALOG.map(async (e) => {
    if (e.linkOnly) return { id: e.id, installed: false, version: null, updateAvailable: false, latest: null };
    if (!isInstalled(e)) return { id: e.id, installed: false, version: null, updateAvailable: false, latest: null };
    let updateAvailable = false;
    let latest = null;
    if (e.npm && Object.prototype.hasOwnProperty.call(npmLatest, e.npm)) {
      updateAvailable = true;
      latest = npmLatest[e.npm];
    } else if ((e.brewCask && brewLatest[e.brewCask] !== undefined) || (e.brew && brewLatest[e.brew] !== undefined)) {
      updateAvailable = true;
      latest = brewLatest[e.brewCask || e.brew] || null;
    }
    const cmd = (e.detect?.commands || [])[0];
    const version = cmd ? await scanCliVersion(cmd, e.versionFlag || "--version") : null;
    return { id: e.id, installed: true, version, updateAvailable, latest };
  }));
  return { scannedAt: Date.now(), entries };
}

function updatesSnapshot() {
  if (_updatesCache.data && Date.now() - _updatesCache.at < UPDATES_TTL_MS) {
    return Promise.resolve(_updatesCache.data);
  }
  if (!_updatesCache.promise) {
    _updatesCache.promise = collectUpdates()
      .then((data) => { _updatesCache = { at: Date.now(), data, promise: null }; return data; })
      .catch(() => { _updatesCache = { at: 0, data: null, promise: null }; return null; });
  }
  return _updatesCache.promise;
}

export default function installRoutes(app) {
  // 安装目录（含已安装状态 + 推荐安装方式 + 新手推荐顺序）
  app.get("/api/install/catalog", (req, res) => {
    const entries = INSTALL_CATALOG.map((e) => {
      const installed = isInstalled(e);
      const picked = pickMethod(e);
      return {
        id: e.id, name: e.name, kind: e.kind, group: e.group,
        icon: e.icon, color: e.color, description: e.description, homepage: e.homepage,
        agentKey: e.agentKey || null,
        installed,
        method: e.linkOnly ? "link" : (installed ? null : (picked ? picked.method : "manual")),
        methodLabel: e.linkOnly ? "官网" : (installed ? null : (picked ? picked.label : "手动")),
        canUninstall: !e.linkOnly && !PROTECTED_UNINSTALL.has(e.id) && !!pickUninstallMethod(e),
      };
    });
    res.json({ brewAvailable: brewAvailable(), starter: STARTER_PATH, entries });
  });

  // 版本 / 更新扫描（已安装条目返回当前版本与是否有更新；首次扫描可能需要数秒）
  app.get("/api/install/updates", async (req, res) => {
    const data = await updatesSnapshot();
    if (!data) return res.status(500).json({ error: "更新扫描失败，请稍后重试" });
    res.json(data);
  });

  // 发起安装 / 更新 / 卸载（白名单 id，命令只来自目录常量，不接受任意用户输入）
  app.post("/api/install", (req, res) => {
    const { id } = req.body || {};
    const action = req.body && req.body.action === "update" ? "update"
      : req.body && req.body.action === "uninstall" ? "uninstall" : "install";
    const entry = getInstallEntry(id);
    if (!entry) return res.status(400).json({ error: `未知安装条目: ${id}` });
    if (entry.linkOnly) return res.status(400).json({ error: `${entry.name} 仅提供官网导航，请从官网获取` });
    if (action === "uninstall") {
      if (PROTECTED_UNINSTALL.has(entry.id)) {
        return res.status(400).json({ error: `${entry.name} 是驾驶舱运行的基础环境，不提供卸载` });
      }
      if (!isInstalled(entry)) return res.status(400).json({ error: `${entry.name} 尚未安装，无需卸载` });
    } else if (action === "update") {
      if (!isInstalled(entry)) return res.status(400).json({ error: `${entry.name} 尚未安装，无需更新` });
    } else {
      if (isInstalled(entry)) return res.status(400).json({ error: `${entry.name} 已经安装` });
    }
    const result = startJob(entry, { action });
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
