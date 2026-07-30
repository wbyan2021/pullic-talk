// ===== 快捷安装目录 =====
// 「App Store」数据源：热门 AI 应用 / 编码 CLI，只收录官方渠道。
// 安装方式优先级：brew cask > brew formula > npm -g > dmg 下载。
//
// 字段：
//   id/name/icon/color/description/homepage   展示用
//   kind        "app"（桌面应用）| "cli"
//   group       "chat" | "editor" | "cli" | "runtime"（UI 分组）
//   detect      { apps?: [...], commands?: [...] } 判断是否已安装
//   brewCask    brew install --cask <x>
//   brew        brew install <x>
//   npm         npm install -g <x>
//   dmg         { url, file } 下载后打开镜像（兜底，需用户拖拽安装）
//   agentKey    对应的群聊 agent（安装后群聊里自动亮起）

export const INSTALL_CATALOG = [
  // ── 桌面 AI 应用 ──
  {
    id: "chatgpt", name: "ChatGPT", kind: "app", group: "chat",
    icon: "✳️", color: "#10a37f",
    description: "OpenAI 官方桌面客户端",
    homepage: "https://openai.com/chatgpt/desktop/",
    detect: { apps: ["ChatGPT.app"] },
    brewCask: "chatgpt",
  },
  {
    id: "claude-app", name: "Claude", kind: "app", group: "chat",
    icon: "🟠", color: "#d97757",
    description: "Anthropic 官方桌面客户端",
    homepage: "https://claude.ai/download",
    detect: { apps: ["Claude.app"] },
    brewCask: "claude",
  },
  {
    id: "ollama", name: "Ollama", kind: "app", group: "runtime",
    icon: "🦙", color: "#f4f4f4",
    description: "本地跑开源大模型（Llama / Qwen / DeepSeek…）",
    homepage: "https://ollama.com/",
    detect: { commands: ["ollama"], apps: ["Ollama.app"] },
    brewCask: "ollama",
  },
  {
    id: "lm-studio", name: "LM Studio", kind: "app", group: "runtime",
    icon: "🧪", color: "#7c5cff",
    description: "本地模型管理 + OpenAI 兼容服务器",
    homepage: "https://lmstudio.ai/",
    detect: { apps: ["LM Studio.app"] },
    brewCask: "lm-studio",
  },
  {
    id: "jan", name: "Jan", kind: "app", group: "chat",
    icon: "🌙", color: "#5f6bff",
    description: "开源离线 AI 助手（100% 本地）",
    homepage: "https://jan.ai/",
    detect: { apps: ["Jan.app"] },
    brewCask: "jan",
  },

  // ── AI 编辑器 / 终端 ──
  {
    id: "cursor", name: "Cursor", kind: "app", group: "editor",
    icon: "▮", color: "#a3a3a3",
    description: "最流行的 AI 编码 IDE",
    homepage: "https://cursor.com/",
    detect: { apps: ["Cursor.app"] },
    brewCask: "cursor",
  },
  {
    id: "windsurf", name: "Windsurf", kind: "app", group: "editor",
    icon: "🏄", color: "#00d4ff",
    description: "Codeium 的 AI 编码 IDE",
    homepage: "https://windsurf.com/",
    detect: { apps: ["Windsurf.app"] },
    brewCask: "windsurf",
  },
  {
    id: "vscode", name: "VS Code", kind: "app", group: "editor",
    icon: "🟦", color: "#2563eb",
    description: "微软编辑器（配 Copilot / Cline 插件）",
    homepage: "https://code.visualstudio.com/",
    detect: { apps: ["Visual Studio Code.app"], commands: ["code"] },
    brewCask: "visual-studio-code",
  },
  {
    id: "warp", name: "Warp", kind: "app", group: "editor",
    icon: "🛞", color: "#4da6ff",
    description: "内置 AI 的现代终端",
    homepage: "https://www.warp.dev/",
    detect: { apps: ["Warp.app"] },
    brewCask: "warp",
  },

  // ── 编码 CLI（装完即可加入群聊）──
  {
    id: "codex", name: "Codex CLI", kind: "cli", group: "cli",
    icon: "◈", color: "#10a37f",
    description: "OpenAI 终端编码代理",
    homepage: "https://github.com/openai/codex",
    detect: { commands: ["codex"] },
    brew: "codex", npm: "@openai/codex",
    agentKey: "codex",
  },
  {
    id: "claude-code", name: "Claude Code", kind: "cli", group: "cli",
    icon: "✳", color: "#d97757",
    description: "Anthropic 终端编码代理",
    homepage: "https://claude.com/claude-code",
    detect: { commands: ["claude"] },
    npm: "@anthropic-ai/claude-code",
    agentKey: "claude",
  },
  {
    id: "gemini-cli", name: "Gemini CLI", kind: "cli", group: "cli",
    icon: "✦", color: "#4285f7",
    description: "Google Gemini 终端代理",
    homepage: "https://github.com/google-gemini/gemini-cli",
    detect: { commands: ["gemini"] },
    npm: "@google/gemini-cli",
    agentKey: "gemini",
  },
  {
    id: "aider", name: "Aider", kind: "cli", group: "cli",
    icon: "▲", color: "#2563eb",
    description: "Git 友好的结对编程 CLI",
    homepage: "https://aider.chat/",
    detect: { commands: ["aider"] },
    brew: "aider",
  },
  {
    id: "opencode", name: "OpenCode", kind: "cli", group: "cli",
    icon: "⌁", color: "#06b6d4",
    description: "开源终端编码代理（免费模型）",
    homepage: "https://opencode.ai/",
    detect: { commands: ["opencode"] },
    npm: "opencode-ai",
    agentKey: "opencode",
  },
  {
    id: "pi-agent", name: "Pi Agent", kind: "cli", group: "cli",
    icon: "π", color: "#a855f7",
    description: "极简编码代理（本项目的老朋友）",
    homepage: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
    detect: { commands: ["pi"] },
    npm: "@earendil-works/pi-coding-agent",
    agentKey: "pi",
  },

  // ── 基础设施 ──
  {
    id: "docker", name: "Docker Desktop", kind: "app", group: "runtime",
    icon: "🐳", color: "#2496ed",
    description: "容器运行环境",
    homepage: "https://www.docker.com/products/docker-desktop/",
    detect: { commands: ["docker"], apps: ["Docker.app"] },
    brewCask: "docker",
  },
  {
    id: "homebrew", name: "Homebrew", kind: "cli", group: "runtime",
    icon: "🍺", color: "#f59e0b",
    description: "macOS 包管理器（一键装应用的前提）",
    homepage: "https://brew.sh/",
    detect: { commands: ["brew"] },
    // 官方安装脚本（非交互模式）
    script: 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
];

export function getInstallEntry(id) {
  return INSTALL_CATALOG.find((e) => e.id === id) || null;
}

// 群聊 agent → 安装条目 反查（用于 chat 页「未安装 → 去安装」）
export function findInstallIdForAgent(agentKey, command) {
  const byKey = INSTALL_CATALOG.find((e) => e.agentKey === agentKey);
  if (byKey) return byKey.id;
  const byCmd = INSTALL_CATALOG.find((e) => (e.detect?.commands || []).includes(command));
  return byCmd ? byCmd.id : null;
}
