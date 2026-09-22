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
// 带引号的值取首对引号内内容（引号后的手写注释忽略）；
// ${VAR:-} 这类回退写法视为“未设置字面量”；
// 未加引号的值按 shell 规则去掉 " #" 之后的手写注释
function prettyValue(raw) {
  if (!raw) return "";
  const first = raw[0];
  if (first === '"' || first === "'") {
    const end = raw.indexOf(first, 1);
    if (end > 0) return raw.slice(1, end);
    return ""; // 引号未闭合：视为未设置字面量，不加载
  }
  if (raw.startsWith("${")) return ""; // 回退表达式交给运行时环境
  const hashIdx = raw.indexOf(" #"); // 未加引号值：空格+# 开始为注释
  if (hashIdx !== -1) return raw.slice(0, hashIdx).trim();
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

// S06/D1：固定掩码，不泄露字符与长度；空值不掩码（调用方据此跳过）
export const MASKED_VALUE = "••••••••";
export function maskValue(value) {
  return value === undefined || value === null || String(value) === "" ? "" : MASKED_VALUE;
}

// S06/D1：给浏览器的快照——键名可见，值一律掩码；有效值为空的键不进入快照
export function getMaskedSnapshot() {
  const vars = getSecretsSnapshot();
  const masked = {};
  for (const [key, value] of Object.entries(vars)) {
    const m = maskValue(value);
    if (m !== "") masked[key] = m;
  }
  return masked;
}

// S06/D2：服务启动时加载 secrets 文件到 process.env。
// 只填充缺失键；启动命令已显式设置的同名变量不覆盖；空值与 ${VAR:-…} 回退写法跳过。
// 返回 { loaded, skipped }，日志只报数量不报值。
export function loadSecretsIntoProcess(path = SECRETS_ENV_PATH, env = process.env) {
  const { lines, exists } = readSecretsFile(path);
  if (!exists) return { loaded: 0, skipped: 0 };
  let loaded = 0;
  let skipped = 0;
  for (const line of lines) {
    const p = parseExportLine(line);
    if (!p) continue;
    const value = prettyValue(p.raw);
    if (value === "") {
      skipped++;
      continue;
    }
    if (env[p.key] !== undefined && env[p.key] !== "") {
      skipped++;
      continue;
    }
    env[p.key] = value;
    loaded++;
  }
  log(`✓ 已从 ${path} 加载 ${loaded} 个环境变量（跳过 ${skipped} 个已设置或空值条目）`);
  return { loaded, skipped };
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
  // 唯一临时名：避免两个并发写回互踩同一个 .tmp（最后一个 rename 胜出，但不会写出混合内容）
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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