import { readFileSync, watch } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { log } from "./utils/log.js";
import { AGENT_CATALOG } from "./agent-catalog.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const CONFIG_PATH = join(ROOT, "agents.config.json");

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
function buildAgents() {
  const merged = {};
  for (const [key, def] of Object.entries(AGENT_CATALOG)) {
    merged[key] = { ...def, source: "builtin" };
  }
  for (const [key, def] of Object.entries(loadUserConfig())) {
    if (!def || typeof def !== "object" || !def.cli?.command) {
      log(`⚠️ 跳过非法 agent 配置: ${key}（缺少 cli.command）`);
      continue;
    }
    merged[key] = { ...def, source: merged[key] ? "override" : "user" };
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
let _reloadTimer = null;
try {
  const watcher = watch(CONFIG_PATH, () => {
    if (_reloadTimer) clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
      const next = buildAgents();
      if (Object.keys(next).length > 0) {
        AGENTS = next;
        refreshAvailability();
        log("✓ config hot-reloaded");
      } else {
        log("⚠️ 配置有误，保留旧配置继续运行");
      }
      _reloadTimer = null;
    }, 300);
  });
  watcher.on("error", (e) => log(`⚠️ config watcher 错误: ${e.message}`));
} catch (e) {
  log(`⚠️ 无法监听 agents.config.json: ${e.message}`);
}

// 启动时探测一次
refreshAvailability();
