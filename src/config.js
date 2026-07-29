import { readFileSync, watch } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { log } from "./utils/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const CONFIG_PATH = join(ROOT, "agents.config.json");

function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    log(`✓ loaded ${Object.keys(cfg).length} agents: ${Object.keys(cfg).join(", ")}`);
    return cfg;
  } catch (e) {
    console.error("⚠️ 加载 agents.config.json 失败:", e.message);
    return null; // 返回 null 表示加载失败，保留旧配置
  }
}

export let AGENTS = loadConfig() || {};

// debounce：文件保存时 watch 可能连续触发多次，300ms 内只加载一次
let _reloadTimer = null;
watch(CONFIG_PATH, () => {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    const cfg = loadConfig();
    if (cfg) {
      AGENTS = cfg;
      log("✓ config hot-reloaded");
    } else {
      log("⚠️ 配置有误，保留旧配置继续运行");
    }
    _reloadTimer = null;
  }, 300);
});

export { loadConfig };
