// ===== 快捷安装目录 =====
// 「App Store」数据源：AI 基础环境 / 热门编码 Agent / 桌面 AI 应用 / 大模型官网，只收录官方渠道。
// 安装方式优先级：官方脚本 > brew cask > brew formula > npm -g > dmg 下载。
//
// 字段：
//   id/name/icon/color/description/homepage   展示用
//   kind        "app"（桌面应用）| "cli" | "link"（仅官网导航）
//   group       "env" | "cli" | "editor" | "chat" | "runtime" | "models"（UI 分组）
//   detect      { apps?: [...], commands?: [...] } 判断是否已安装
//   script      官方安装脚本（https 来源，写死在本文件，不接受用户输入）
//   brewCask    brew install --cask <x>
//   brew        brew install <x>
//   npm         npm install -g <x>
//   dmg         { url, file } 下载后打开镜像（兜底，需用户拖拽安装）
//   versionFlag 版本探测参数，默认 "--version"；ffmpeg 用 "-version"
//   linkOnly    true = 仅官网导航卡片，不参与安装
//   agentKey    对应的群聊 agent（安装后群聊里自动亮起）

// 新手推荐安装顺序（前端在安装页顶部以横条展示，逐个点亮）
export const STARTER_PATH = [
  "homebrew", "node", "git",
  "claude-code", "codex", "gemini-cli", "qwen-code",
];

export const INSTALL_CATALOG = [
  // ── 基础环境（AI 工具链的前提）──
  {
    id: "homebrew", name: "Homebrew", kind: "cli", group: "env",
    icon: "🍺", color: "#f59e0b",
    description: "macOS 包管理器（一键装应用的前提，建议第一个装）",
    homepage: "https://brew.sh/",
    detect: { commands: ["brew"] },
    // 官方安装脚本（非交互模式）
    script: 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
  },
  {
    id: "node", name: "Node.js", kind: "cli", group: "env",
    icon: "🟩", color: "#3c873a",
    description: "JavaScript 运行时 — 绝大多数 AI Agent CLI 的基础（本驾驶舱也在上面跑）",
    homepage: "https://nodejs.org/zh-cn",
    detect: { commands: ["node"] },
    brew: "node",
  },
  {
    id: "git", name: "Git", kind: "cli", group: "env",
    icon: "🌿", color: "#f05033",
    description: "版本控制 — 本驾驶舱项目边界与黑匣子的核心依赖",
    homepage: "https://git-scm.com/",
    detect: { commands: ["git"] },
    brew: "git",
  },
  {
    id: "python", name: "Python 3", kind: "cli", group: "env",
    icon: "🐍", color: "#3776ab",
    description: "Python 运行时 — AI 脚本、数据处理与模型调用的通用语言",
    homepage: "https://www.python.org/",
    detect: { commands: ["python3"] },
    brew: "python",
  },
  {
    id: "uv", name: "uv", kind: "cli", group: "env",
    icon: "⚡", color: "#de5fe9",
    description: "极速 Python 环境与包管理器（AI 项目新标配，可代替 pip / venv）",
    homepage: "https://docs.astral.sh/uv/",
    detect: { commands: ["uv"] },
    script: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  },
  {
    id: "ffmpeg", name: "FFmpeg", kind: "cli", group: "env",
    icon: "🎬", color: "#0074a8",
    description: "音视频处理 — AI 视频 / 语音工作流的瑞士军刀",
    homepage: "https://ffmpeg.org/",
    detect: { commands: ["ffmpeg"] },
    versionFlag: "-version",
    brew: "ffmpeg",
  },

  // ── 编码 / Agent CLI（装完即可加入群聊）──
  {
    id: "claude-code", name: "Claude Code", kind: "cli", group: "cli",
    icon: "✳", color: "#d97757",
    description: "Anthropic 终端编码代理（公认能力第一梯队）",
    homepage: "https://claude.com/claude-code",
    detect: { commands: ["claude"] },
    npm: "@anthropic-ai/claude-code",
    agentKey: "claude",
  },
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
    id: "gemini-cli", name: "Gemini CLI", kind: "cli", group: "cli",
    icon: "✦", color: "#4285f7",
    description: "Google Gemini 终端代理（免费额度大方）",
    homepage: "https://github.com/google-gemini/gemini-cli",
    detect: { commands: ["gemini"] },
    npm: "@google/gemini-cli",
    agentKey: "gemini",
  },
  {
    id: "qwen-code", name: "Qwen Code", kind: "cli", group: "cli",
    icon: "🔶", color: "#615ced",
    description: "阿里通义千问编码代理（国内直连、有免费额度）",
    homepage: "https://github.com/QwenLM/qwen-code",
    detect: { commands: ["qwen"] },
    npm: "@qwen-code/qwen-code",
  },
  {
    id: "kimi-code", name: "Kimi Code", kind: "cli", group: "cli",
    icon: "🌙", color: "#0ea5a4",
    description: "Moonshot Kimi 终端编码代理",
    homepage: "https://www.kimi.com/",
    detect: { commands: ["kimi"] },
    brew: "kimi-code", npm: "@moonshot-ai/kimi-code",
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
    id: "openclaw", name: "OpenClaw", kind: "cli", group: "cli",
    icon: "🦞", color: "#ef6c4d",
    description: "开源个人 AI 助理 — 跑在自己设备上，接入微信 / WhatsApp 等聊天软件",
    homepage: "https://openclaw.ai/",
    detect: { commands: ["openclaw"] },
    script: "curl -fsSL https://openclaw.ai/install.sh | bash",
    agentKey: "openclaw",
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
    id: "pi-agent", name: "Pi Agent", kind: "cli", group: "cli",
    icon: "π", color: "#a855f7",
    description: "极简编码代理（本项目的老朋友）",
    homepage: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
    detect: { commands: ["pi"] },
    npm: "@earendil-works/pi-coding-agent",
    agentKey: "pi",
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
    id: "jan", name: "Jan", kind: "app", group: "chat",
    icon: "🌙", color: "#5f6bff",
    description: "开源离线 AI 助手（100% 本地）",
    homepage: "https://jan.ai/",
    detect: { apps: ["Jan.app"] },
    brewCask: "jan",
  },

  // ── 本地模型运行时 ──
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
    id: "docker", name: "Docker Desktop", kind: "app", group: "runtime",
    icon: "🐳", color: "#2496ed",
    description: "容器运行环境",
    homepage: "https://www.docker.com/products/docker-desktop/",
    detect: { commands: ["docker"], apps: ["Docker.app"] },
    brewCask: "docker",
  },

  // ── 热门大模型官网（仅导航，不安装）──
  {
    id: "site-openai", name: "OpenAI", kind: "link", group: "models", linkOnly: true,
    icon: "✳️", color: "#10a37f",
    description: "GPT 系列模型 / ChatGPT / API 平台",
    homepage: "https://openai.com/",
  },
  {
    id: "site-anthropic", name: "Anthropic", kind: "link", group: "models", linkOnly: true,
    icon: "🟠", color: "#d97757",
    description: "Claude 系列模型与 API（Constitutional AI）",
    homepage: "https://www.anthropic.com/",
  },
  {
    id: "site-gemini", name: "Google Gemini", kind: "link", group: "models", linkOnly: true,
    icon: "✦", color: "#4285f7",
    description: "Gemini 系列模型（免费档可用）",
    homepage: "https://gemini.google.com/",
  },
  {
    id: "site-deepseek", name: "DeepSeek", kind: "link", group: "models", linkOnly: true,
    icon: "🐋", color: "#4d6bfe",
    description: "深度求索 — 本驾驶舱第一个护航 Provider",
    homepage: "https://www.deepseek.com/",
  },
  {
    id: "site-qwen", name: "通义千问 Qwen", kind: "link", group: "models", linkOnly: true,
    icon: "🔷", color: "#615ced",
    description: "阿里通义千问系列（Qwen / 百炼平台）",
    homepage: "https://chat.qwen.ai/",
  },
  {
    id: "site-kimi", name: "Kimi", kind: "link", group: "models", linkOnly: true,
    icon: "🌙", color: "#0ea5a4",
    description: "月之暗面 Kimi（K2 开源系列）",
    homepage: "https://www.kimi.com/",
  },
  {
    id: "site-zhipu", name: "智谱 GLM", kind: "link", group: "models", linkOnly: true,
    icon: "🧩", color: "#3b82f6",
    description: "智谱清言 / GLM 系列大模型",
    homepage: "https://chatglm.cn/",
  },
  {
    id: "site-doubao", name: "豆包", kind: "link", group: "models", linkOnly: true,
    icon: "🫘", color: "#ee3b24",
    description: "字节跳动豆包（火山方舟提供 API）",
    homepage: "https://www.doubao.com/",
  },
  {
    id: "site-minimax", name: "MiniMax", kind: "link", group: "models", linkOnly: true,
    icon: "🌀", color: "#e8590c",
    description: "MiniMax 大模型与海螺 AI",
    homepage: "https://www.minimaxi.com/",
  },
  {
    id: "site-grok", name: "xAI Grok", kind: "link", group: "models", linkOnly: true,
    icon: "⚡", color: "#1d9bf0",
    description: "马斯克 xAI 的 Grok 系列",
    homepage: "https://grok.com/",
  },
  {
    id: "site-llama", name: "Meta Llama", kind: "link", group: "models", linkOnly: true,
    icon: "🦙", color: "#0866ff",
    description: "Llama 开源权重系列（可本地部署）",
    homepage: "https://www.llama.com/",
  },
  {
    id: "site-mistral", name: "Mistral AI", kind: "link", group: "models", linkOnly: true,
    icon: "🌬️", color: "#fa500f",
    description: "欧洲开源大模型代表",
    homepage: "https://mistral.ai/",
  },
  {
    id: "site-openrouter", name: "OpenRouter", kind: "link", group: "models", linkOnly: true,
    icon: "🔀", color: "#8b5cf6",
    description: "模型聚合网关 — 一个 Key 调用各家大模型",
    homepage: "https://openrouter.ai/",
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
