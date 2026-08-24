import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

// 当前要管理的 env 文件路径（默认 ~/.secrets.env；测试可注入）
export const SECRETS_ENV_PATH = process.env.SECRETS_ENV_PATH || join(homedir(), ".secrets.env");

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const EXPORT_RE = /^[ \t]*export[ \t]+([A-Za-z_][A-Za-z0-9_]*)=([ \t]*.*)$/;

// 把值安全地写成 shell 单引号形式：foo's bar -> 'foo'"'"'s bar'
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 解析 export KEY=... 行，返回 { key, raw }；非 export 行返回 null
function parseExportLine(line) {
  const m = EXPORT_RE.exec(line);
  if (!m) return null;
  return { key: m[1], raw: m[2].trim() };
}

// 从原始 RHS 提取“看起来易读”的值：
// 去掉单/双引号外壳；${VAR:-} 这类回退写法视为“未设置字面量”
function prettyValue(raw) {
  if (!raw) return "";
  const first = raw[0];
  if (first === '"' && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1);
  if (first === "'" && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1);
  if (raw.startsWith("${")) return ""; // 回退表达式交给运行时环境
  return raw;
}

// 读取文件并解析所有 export 行（保留原始行与注释）
export function readSecretsFile(path = SECRETS_ENV_PATH) {
  let lines = [];
  try {
    lines = readFileSync(path, "utf-8").split("\n");
    // 去掉最后可能存在的单一空行，写回时统一拼接
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
  } catch {
    return { path, exists: false, lines: [] };
  }
  return { path, exists: true, lines };
}

// 快照：文件里每个 key 的“待编辑值”= 运行时环境值优先，其次文件里字面值
export function getSecretsSnapshot() {
  const { lines } = readSecretsFile();
  const vars = {};
  for (const line of lines) {
    const p = parseExportLine(line);
    if (!p) continue;
    const runtime = process.env[p.key];
    if (runtime !== undefined && runtime !== "") {
      vars[p.key] = runtime;
    } else {
      vars[p.key] = prettyValue(p.raw);
    }
  }
  return vars;
}

// 写回文件：替换或新增 vars 里的 key；值为空字符串表示删除该 key
// 尽量保留原文件中的注释与非 export 行
export function writeSecretsFile(vars) {
  const path = SECRETS_ENV_PATH;
  const { lines, exists } = readSecretsFile(path);

  const next = [];
  const handled = new Set();
  for (const line of lines) {
    const p = parseExportLine(line);
    if (!p || !(p.key in vars)) {
      next.push(line);
      continue;
    }
    handled.add(p.key);
    const value = String(vars[p.key] ?? "");
    if (value.trim() === "") continue; // 空值 = 删除该行
    next.push(`export ${p.key}=${shellQuote(value)}`);
  }

  // 新增 key 追加到文件末尾，并加一个说明注释（只在真正新增时）
  const newKeys = Object.keys(vars).filter((k) => !handled.has(k) && String(vars[k] ?? "").trim() !== "");
  if (newKeys.length > 0) {
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push("# 以下由网页端「Key 管理」添加");
    for (const key of newKeys) {
      next.push(`export ${key}=${shellQuote(String(vars[key]))}`);
    }
  }

  const content = next.join("\n") + "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    // 尽量收紧权限；如果文件系统不支持会抛错，但不影响功能
    chmodSync(path, 0o600);
  } catch {}
  if (!exists) {
    log(`✓ 已创建 ${path}`);
  }
  log(`✓ 已更新 ${path}（${Object.keys(vars).length} 个 key）`);
  return path;
}

export { KEY_RE };