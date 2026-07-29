#!/usr/bin/env node
/**
 * scan-tools.js — 本机 AI / 开发工具自动发现扫描器
 *
 * 扫描范围：
 *   1. /Applications、~/Applications 下的 .app
 *   2. PATH 中的 CLI 命令（command -v）
 *   3. npm 全局包
 *   4. 常见服务端口探测
 *
 * 输出：覆写 tools.json，仅保留已安装工具 + 新发现的工具
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import net from "net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TOOLS_PATH = join(ROOT, "tools.json");

/* ═══════════════════════════════════════════
   已知工具目录（catalog）
   每个条目包含完整元数据，扫描时按 detect 规则匹配
   ═══════════════════════════════════════════ */

const CATALOG = [
  // ── 编码 Agent（CLI）──
  {
    id: "grok", name: "Grok Build", kind: "cli", category: "agent",
    icon: "G", color: "#1d9bf0",
    description: "技术主导 · 可派子代理并行",
    tags: ["coding", "agent", "multi-agent"],
    detect: { commands: ["grok"] },
    launch: { type: "terminal", command: "grok" },
  },
  {
    id: "pi", name: "Pi Agent", kind: "cli", category: "agent",
    icon: "π", color: "#a855f7",
    description: "独立编码手 · 单线程专注",
    tags: ["coding", "agent"],
    detect: { commands: ["pi"] },
    launch: { type: "terminal", command: "pi" },
    quickActions: [
      { label: "pi --web", command: "pi --web", openUrl: "http://localhost:4321", openDelay: 2500 },
    ],
  },
  {
    id: "openclaw", name: "OpenClaw", kind: "cli", category: "agent",
    icon: "🦞", color: "#f59e0b",
    description: "运营协调 · 8 个子代理",
    tags: ["agent", "multi-agent", "ops"],
    detect: { commands: ["openclaw"] },
    launch: { type: "terminal", command: "openclaw" },
  },
  {
    id: "opencode", name: "OpenCode", kind: "cli", category: "agent",
    icon: "⌁", color: "#06b6d4",
    description: "助理编码 · 免费模型",
    tags: ["coding", "agent"],
    detect: { commands: ["opencode"] },
    launch: { type: "terminal", command: "opencode" },
  },
  {
    id: "codex", name: "Codex CLI", kind: "cli", category: "agent",
    icon: "◈", color: "#10a37f",
    description: "OpenAI 终端编码代理",
    tags: ["coding", "agent"],
    detect: { commands: ["codex"] },
    launch: { type: "terminal", command: "codex" },
  },
  {
    id: "claude-code", name: "Claude Code", kind: "cli", category: "agent",
    icon: "✳", color: "#d97757",
    description: "Anthropic 终端编码代理",
    tags: ["coding", "agent"],
    detect: { commands: ["claude"] },
    launch: { type: "terminal", command: "claude" },
  },
  {
    id: "aider", name: "Aider", kind: "cli", category: "agent",
    icon: "▲", color: "#2563eb",
    description: "Git 友好的结对编程 CLI",
    tags: ["coding", "agent"],
    detect: { commands: ["aider"] },
    launch: { type: "terminal", command: "aider" },
  },
  {
    id: "gemini", name: "Gemini CLI", kind: "cli", category: "agent",
    icon: "✦", color: "#4285f4",
    description: "Google Gemini 终端代理",
    tags: ["coding", "agent"],
    detect: { commands: ["gemini"] },
    launch: { type: "terminal", command: "gemini" },
  },
  {
    id: "amp", name: "Amp", kind: "cli", category: "agent",
    icon: "⚡", color: "#f97316",
    description: "Sourcegraph Amp 编码代理",
    tags: ["coding", "agent"],
    detect: { commands: ["amp"] },
    launch: { type: "terminal", command: "amp" },
  },
  {
    id: "goose", name: "Goose", kind: "cli", category: "agent",
    icon: "🪿", color: "#84cc16",
    description: "Block 出品的开源 agent",
    tags: ["coding", "agent"],
    detect: { commands: ["goose"] },
    launch: { type: "terminal", command: "goose" },
  },
  {
    id: "qoder", name: "Qoder", kind: "cli", category: "agent",
    icon: "Q", color: "#6366f1",
    description: "AI 编码代理",
    tags: ["coding", "agent"],
    detect: { commands: ["qoder"] },
    launch: { type: "terminal", command: "qoder" },
  },

  // ── 本地模型 ──
  {
    id: "ollama", name: "Ollama", kind: "app", category: "model",
    icon: "🦙", color: "#f4f4f5",
    description: "本地大模型运行时 · :11434",
    tags: ["model", "local", "runtime"],
    detect: { apps: ["Ollama.app"], commands: ["ollama"] },
    launch: { type: "app", app: "Ollama" },
    quickActions: [
      { label: "ollama list", command: "ollama list" },
      { label: "API", url: "http://localhost:11434" },
    ],
    service: { port: 11434 },
  },
  {
    id: "lmstudio", name: "LM Studio", kind: "app", category: "model",
    icon: "🧠", color: "#8b5cf6",
    description: "本地模型 GUI · OpenAI 兼容 :1234",
    tags: ["model", "local", "gui"],
    detect: { apps: ["LM Studio.app"] },
    launch: { type: "app", app: "LM Studio" },
    quickActions: [
      { label: "API :1234", url: "http://localhost:1234/v1/models" },
    ],
    service: { port: 1234 },
  },

  // ── 对话 App ──
  {
    id: "chatgpt", name: "ChatGPT", kind: "app", category: "chat",
    icon: "●", color: "#10a37f",
    description: "OpenAI 桌面客户端",
    tags: ["chat"],
    detect: { apps: ["ChatGPT.app"] },
    launch: { type: "app", app: "ChatGPT" },
  },
  {
    id: "claude-app", name: "Claude", kind: "app", category: "chat",
    icon: "✳", color: "#d97757",
    description: "Anthropic 桌面客户端",
    tags: ["chat"],
    detect: { apps: ["Claude.app"] },
    launch: { type: "app", app: "Claude" },
  },
  {
    id: "copilot-app", name: "GitHub Copilot", kind: "app", category: "chat",
    icon: "⌥", color: "#6e7681",
    description: "GitHub Copilot 桌面版",
    tags: ["chat", "coding"],
    detect: { apps: ["GitHub Copilot.app"] },
    launch: { type: "app", app: "GitHub Copilot" },
  },
  {
    id: "chatbox", name: "Chatbox", kind: "app", category: "chat",
    icon: "💬", color: "#f59e0b",
    description: "多模型桌面 AI 客户端",
    tags: ["chat", "multi-model"],
    detect: { apps: ["Chatbox.app"] },
    launch: { type: "app", app: "Chatbox" },
  },
  {
    id: "doubao", name: "豆包", kind: "app", category: "chat",
    icon: "🫘", color: "#3b82f6",
    description: "字节跳动 AI 助手",
    tags: ["chat"],
    detect: { apps: ["Doubao.app"] },
    launch: { type: "app", app: "Doubao" },
  },
  {
    id: "qianwen", name: "通义千问", kind: "app", category: "chat",
    icon: "🔮", color: "#6366f1",
    description: "阿里通义千问桌面版",
    tags: ["chat"],
    detect: { apps: ["Qianwen.app"] },
    launch: { type: "app", app: "Qianwen" },
  },
  {
    id: "minimax", name: "MiniMax Hub", kind: "app", category: "chat",
    icon: "🌀", color: "#ec4899",
    description: "MiniMax 大模型平台",
    tags: ["chat", "platform"],
    detect: { apps: ["MiniMax Hub.app"] },
    launch: { type: "app", app: "MiniMax Hub" },
  },

  // ── 编辑器 / IDE ──
  {
    id: "cursor", name: "Cursor", kind: "app", category: "editor",
    icon: "▮", color: "#e4e4e7",
    description: "AI 优先的代码编辑器",
    tags: ["editor", "ai"],
    detect: { apps: ["Cursor.app"], commands: ["cursor"] },
    launch: { type: "app", app: "Cursor" },
  },
  {
    id: "trae", name: "Trae", kind: "app", category: "editor",
    icon: "△", color: "#22d3ee",
    description: "字节跳动 AI IDE",
    tags: ["editor", "ai", "ide"],
    detect: { apps: ["Trae CN.app", "TRAE SOLO CN.app", "Trae.app"] },
    launch: { type: "app", app: "Trae CN" },
  },
  {
    id: "obsidian", name: "Obsidian", kind: "app", category: "editor",
    icon: "◆", color: "#7c3aed",
    description: "本地知识库 / 笔记",
    tags: ["notes", "knowledge"],
    detect: { apps: ["Obsidian.app"] },
    launch: { type: "app", app: "Obsidian" },
  },
  {
    id: "zed", name: "Zed", kind: "app", category: "editor",
    icon: "Z", color: "#0870ff",
    description: "高性能协作编辑器",
    tags: ["editor"],
    detect: { apps: ["Zed.app"], commands: ["zed"] },
    launch: { type: "app", app: "Zed" },
  },
  {
    id: "vscode", name: "VS Code", kind: "app", category: "editor",
    icon: "📝", color: "#007acc",
    description: "微软代码编辑器",
    tags: ["editor"],
    detect: { apps: ["Visual Studio Code.app"], commands: ["code"] },
    launch: { type: "app", app: "Visual Studio Code" },
  },
  {
    id: "hbuilderx", name: "HBuilderX", kind: "app", category: "editor",
    icon: "H", color: "#2b9939",
    description: "DCloud 前端开发工具",
    tags: ["editor", "web"],
    detect: { apps: ["HBuilderX.app"] },
    launch: { type: "app", app: "HBuilderX" },
  },

  // ── 开发工具（CLI）──
  {
    id: "gh", name: "GitHub CLI", kind: "cli", category: "utility",
    icon: "⎇", color: "#8b949e",
    description: "gh · 含 Copilot 扩展",
    tags: ["git", "cli"],
    detect: { commands: ["gh"] },
    launch: { type: "terminal", command: "gh copilot" },
  },
  {
    id: "uv", name: "uv", kind: "cli", category: "utility",
    icon: "🐍", color: "#3b82f6",
    description: "极速 Python 包/环境管理",
    tags: ["python", "cli"],
    detect: { commands: ["uv"] },
    launch: { type: "terminal", command: "uv" },
  },
  {
    id: "docker", name: "Docker", kind: "cli", category: "utility",
    icon: "🐳", color: "#2496ed",
    description: "容器化平台",
    tags: ["container", "devops"],
    detect: { commands: ["docker"], apps: ["Docker.app"] },
    launch: { type: "terminal", command: "docker ps" },
  },
  {
    id: "brew", name: "Homebrew", kind: "cli", category: "utility",
    icon: "🍺", color: "#f59e0b",
    description: "macOS 包管理器",
    tags: ["package-manager"],
    detect: { commands: ["brew"] },
    launch: { type: "terminal", command: "brew list" },
  },
];

/* ═══════════════════════════════════════════
   扫描引擎
   ═══════════════════════════════════════════ */

/** 检测 CLI 命令是否存在，返回路径或 null */
function whichCmd(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}

/** 收集 /Applications + ~/Applications 下所有 .app 名称 */
function listApps() {
  const dirs = ["/Applications", join(process.env.HOME || "", "Applications")];
  const apps = new Set();
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) {
        if (f.endsWith(".app")) apps.add(f);
      }
    } catch { /* 目录不存在则跳过 */ }
  }
  return apps;
}

/** 探测端口是否在线 */
function probePort(port, host = "127.0.0.1", timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

/** npm 全局包列表 */
function npmGlobalPackages() {
  try {
    const out = execSync("npm ls -g --depth=0 --json 2>/dev/null", { encoding: "utf-8", timeout: 8000, stdio: ["pipe", "pipe", "pipe"] });
    const data = JSON.parse(out);
    return Object.keys(data.dependencies || {});
  } catch {
    return [];
  }
}

/* ═══════════════════════════════════════════
   主流程
   ═══════════════════════════════════════════ */

async function main() {
  console.log("🔍 开始扫描本机工具…\n");

  const installedApps = listApps();
  const npmPkgs = npmGlobalPackages();
  const tools = [];
  const services = {};
  const seen = new Set();

  for (const entry of CATALOG) {
    const det = entry.detect || {};
    let foundPath = null;

    // 1) 检测 .app
    if (det.apps) {
      for (const appName of det.apps) {
        if (installedApps.has(appName)) {
          // 尝试找到完整路径
          for (const dir of ["/Applications", join(process.env.HOME || "", "Applications")]) {
            const full = join(dir, appName);
            if (existsSync(full)) { foundPath = full; break; }
          }
          break;
        }
      }
    }

    // 2) 检测 CLI 命令
    if (!foundPath && det.commands) {
      for (const cmd of det.commands) {
        const p = whichCmd(cmd);
        if (p) { foundPath = p; break; }
      }
    }

    if (!foundPath) continue; // 未安装，跳过

    // 构建工具条目
    const tool = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      category: entry.category,
      icon: entry.icon,
      color: entry.color,
      description: entry.description,
      tags: entry.tags,
      detect: entry.detect,
      launch: entry.launch,
      installed: true,
      path: foundPath,
    };
    if (entry.quickActions) tool.quickActions = entry.quickActions;

    tools.push(tool);
    seen.add(entry.id);

    // 服务端口探测
    if (entry.service) {
      const online = await probePort(entry.service.port);
      services[entry.id] = { port: entry.service.port, online };
    }

    console.log(`  ✓ ${entry.name}  →  ${foundPath}`);
  }

  // 3) 扫描 npm 全局包中可能的 AI 工具（补充发现）
  const NPM_KNOWN = {
    "openclaw": "openclaw",
    "opencode-ai": "opencode",
    "@earendil-works/pi-coding-agent": "pi",
    "pi-web": "pi",
    "bailian-cli": null, // 百炼 CLI，暂不加入
  };
  for (const pkg of npmPkgs) {
    const mappedId = NPM_KNOWN[pkg];
    if (mappedId && seen.has(mappedId)) continue; // 已通过 PATH 发现
    // 未来可在此处扩展：未知 npm AI 包自动加入
  }

  // 4) 读取旧 tools.json，保留手动添加的自定义条目（不在 CATALOG 中的）
  let oldTools = [];
  try {
    const old = JSON.parse(readFileSync(TOOLS_PATH, "utf-8"));
    oldTools = old.tools || [];
  } catch { /* 首次运行无旧文件 */ }

  const catalogIds = new Set(CATALOG.map((c) => c.id));
  for (const t of oldTools) {
    if (!catalogIds.has(t.id) && t.installed) {
      // 用户手动添加的自定义工具，保留
      tools.push(t);
      console.log(`  ✓ ${t.name}  →  ${t.path || "(自定义)"}  [保留]`);
    }
  }

  // 按分类排序
  const CAT_ORDER = ["agent", "model", "chat", "editor", "utility"];
  tools.sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));

  const result = {
    version: 1,
    updatedAt: new Date().toISOString(),
    services,
    tools,
  };

  writeFileSync(TOOLS_PATH, JSON.stringify(result, null, 2) + "\n", "utf-8");

  console.log(`\n✅ 扫描完成：发现 ${tools.length} 个已安装工具，${Object.keys(services).length} 个服务`);
  console.log(`   已写入 ${TOOLS_PATH}`);
}

main().catch((e) => {
  console.error("扫描失败:", e.message);
  process.exit(1);
});
