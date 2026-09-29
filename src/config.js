import { readFileSync, writeFileSync, renameSync, watch } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { log } from "./utils/log.js";
import { AGENT_CATALOG } from "./agent-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// 默认仍为项目根 agents.config.json；测试或隔离实例可用 AGENTS_CONFIG_PATH 覆盖
const CONFIG_PATH = process.env.AGENTS_CONFIG_PATH || join(ROOT, "agents.config.json");

// ===== 用户配置加载（agents.config.json = 自定义/覆盖层）=====
function loadUserConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    log(`✓ loaded ${Object.keys(cfg).length} user agents: ${Object.keys(cfg).join(", ")}`);
    return cfg;
  } catch (e) {
    // 文件不存在/损坏都不致命：内置目录仍可用
    log(`⚠️ agents.config.json 加载失败（${e.message}），仅使用内置 agent 目录`);
    return {};
  }
}

// ===== 合并：内置目录 + 用户覆盖（同名整体覆盖）=====
// 用户配置读写（给成员维护 API 用）
export function getUserConfigRaw() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeUserConfig(cfg) {
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function buildAgents() {
  const merged = {};
  for (const [key, def] of Object.entries(AGENT_CATALOG)) {
    merged[key] = { ...def, source: "builtin" };
  }
  for (const [key, def] of Object.entries(loadUserConfig())) {
    if (!def || typeof def !== "object") {
      log(`⚠️ 跳过非法 agent 配置: ${key}（不是对象）`);
      continue;
    }
    // 自定义成员必须给 cli.command；内置成员允许只覆盖部分字段（如 model / enabled）
    const isBuiltin = !!merged[key];
    if (!isBuiltin && !def.cli?.command) {
      log(`⚠️ 跳过非法 agent 配置: ${key}（缺少 cli.command）`);
      continue;
    }
    const base = merged[key] || {};
    merged[key] = {
      ...base,
      ...def,
      // cli 深浅合并：覆盖项优先，未提供的字段继承内置默认
      cli: { ...(base.cli || {}), ...(def.cli || {}) },
      source: isBuiltin ? "override" : "user",
    };
  }
  // enabled:false 表示成员被停用，不进入 AGENTS（群聊目标）
  for (const [key, def] of Object.entries(merged)) {
    if (def.enabled === false) delete merged[key];
  }
  return merged;
}

export let AGENTS = buildAgents();

// ===== CLI 可用性探测（带 TTL 缓存）=====
// 换电脑后各人装的 CLI 不同：这里实时检测 command 是否在 PATH，
// /api/models 据此告诉前端哪些 agent 可用、哪些该灰显。
let _availCache = { at: 0, map: new Map() };
const AVAIL_TTL_MS = 30_000;

function which(cmd) {
  // 不经 shell，避免配置里的命令字符串被注入解析
  try {
    const r = spawnSync("/usr/bin/which", [cmd], { encoding: "utf-8", timeout: 3000 });
    if (r.status === 0) return r.stdout.trim() || null;
  } catch {}
  return null;
}

export function refreshAvailability() {
  const map = new Map();
  for (const [key, agent] of Object.entries(AGENTS)) {
    const path = which(agent.cli.command);
    map.set(key, { available: !!path, path });
  }
  _availCache = { at: Date.now(), map };
  const ok = [...map.entries()].filter(([, v]) => v.available).map(([k]) => k);
  log(`✓ agent 可用性: ${ok.length ? ok.join(", ") : "（无可用 CLI）"}`);
  return map;
}

export function getAvailability() {
  if (Date.now() - _availCache.at > AVAIL_TTL_MS) refreshAvailability();
  return _availCache.map;
}

// ===== 配置热加载（debounce，失败保留旧配置）=====
// 显式热加载：成员维护 API 写盘后调用；失败保留旧配置并返回 false
export function reloadConfig() {
  if (_reloadTimer) { clearTimeout(_reloadTimer); _reloadTimer = null; }
  const next = buildAgents();
  if (Object.keys(next).length > 0) {
    AGENTS = next;
    refreshAvailability();
    return true;
  }
  log("⚠️ 配置有误，保留旧配置继续运行");
  return false;
}

let _reloadTimer = null;
const scheduleReload = () => {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    reloadConfig();
    _reloadTimer = null;
  }, 300);
};

// 文件 + 目录双监听：
//   writeUserConfig 用 tmp + rename 换掉 inode，只监听文件的 watcher 会在第一次
//   内部写盘后永久失联（同一缺陷已在 server.js 的 HTML 热加载上修过，这里此前漏改）。
//   目录监听按 basename 严格过滤，避免 tools.json / .token 等同目录改动触发无谓重建。
//   scheduleReload 本身有 300ms 去抖，两个 watcher 同时命中是无害的。
const CONFIG_BASENAME = basename(CONFIG_PATH);

function attachWatcher(target, describe) {
  try {
    const watcher = watch(target, describe);
    watcher.on("error", (e) => log(`⚠️ config watcher 错误: ${e.message}`));
    // unref：不让 watcher 独自撑住事件循环（服务器由 HTTP 监听保活；
    // 测试进程 import 本模块后也能正常退出）
    watcher.unref();
    return true;
  } catch (e) {
    log(`⚠️ 无法监听 ${target}: ${e.message}`);
    return false;
  }
}

attachWatcher(CONFIG_PATH, scheduleReload);
attachWatcher(dirname(CONFIG_PATH), (_event, filename) => {
  if (filename === CONFIG_BASENAME) scheduleReload();
});

// 启动时探测一次
refreshAvailability();
