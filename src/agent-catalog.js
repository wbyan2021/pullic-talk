// ===== 内置 Agent 适配器目录 =====
// 换电脑后无需任何配置：只要本机装了对应 CLI，群聊里就会自动出现该 agent。
// agents.config.json 中的同名条目会整体覆盖这里的默认值（用户自定义优先）。
//
// cli 字段说明：
//   command/args    一次性调用的命令与参数，{prompt}/{model} 为占位符
//   parseMode       "text"（纯文本流）| "ndjson"（逐行 JSON）| "json-envelope"（整体一个 JSON）
//   textType        ndjson 事件类型过滤（字符串或数组；不填=不过滤）
//   textField(s)    ndjson 文本字段点路径（字符串或数组，按序尝试）
//   jsonTextField   json-envelope 的文本字段点路径
//   thinkingFlag/Map  思考深度开关
//   stdio           "ignore" = stdin 不传 prompt（prompt 在 args 里）
//   timeoutMs       覆盖默认 180s 超时

export const AGENT_CATALOG = {
  // ── 原 agents.config.json 四件套（作为内置默认，用户配置可覆盖）──
  grok: {
    name: "Grok Build",
    role: "技术主导·可派子代理",
    color: "#1d9bf0",
    avatar: "G",
    persona: "你是群聊中的「技术主导」。你的能力：\n1. 你可以 spawn 子代理并行处理复杂任务（调研、实现、测试、审查）\n2. 擅长深度代码分析、架构设计、bug 排查\n3. 遇到大任务时主动拆解，可以分派子代理同时工作\n4. 对其他 AI 的代码方案做技术把关\n你是团队里唯一能多线程工作的，复杂任务由你主导。",
    cli: {
      command: "grok",
      args: ["-p", "{prompt}", "--model", "{model}", "--output-format", "streaming-json", "--yolo", "--max-turns", "3"],
      thinkingFlag: "--reasoning-effort",
      thinkingMap: { off: "none", low: "low", medium: "medium", high: "high", max: "max" },
      parseMode: "ndjson",
      textField: "data",
      textType: "text",
      stdio: "pipe",
    },
  },

  pi: {
    name: "Pi Agent",
    role: "独立编码·单线程",
    color: "#a855f7",
    avatar: "π",
    persona: "你是群聊中的「独立编码手」。你的特点：\n1. 你是单 agent，不能派子代理，但单兵能力强\n2. 擅长独立完成一个完整的编码任务\n3. 适合做创意方案、原型验证、快速实验\n4. 不要假装能并行处理多任务，专注做好一件事\n你的优势是专注和灵活，给一个明确任务就能干净利落地完成。",
    cli: {
      command: "pi",
      args: ["-p", "{prompt}", "--model", "{model}", "--no-session"],
      thinkingFlag: "--thinking",
      thinkingMap: { off: "off", low: "low", medium: "medium", high: "high", max: "max" },
      parseMode: "text",
      stdio: "ignore",
    },
  },

  openclaw: {
    name: "OpenClaw",
    role: "运营协调·8个子代理",
    color: "#f59e0b",
    avatar: "OC",
    persona: "你是群聊中的「运营协调者」。你的定位：\n1. 你是运营型 AI，不是程序员，不要硬写代码\n2. 你有 8 个专业子代理（内容、健康、合规、知识、媒体、运维、日程、代码）\n3. 擅长任务分配、进度跟进、风险评估、资源协调\n4. 关注合规性和实际可落地性\n5. 编程问题交给 Grok 或 Pi，你负责判断「该谁做、怎么做」\n你是团队的管理者，不是执行者。",
    cli: {
      command: "openclaw",
      args: ["agent", "--agent", "main", "--message", "{prompt}", "--model", "{model}", "--json"],
      thinkingFlag: "--thinking",
      thinkingMap: { off: "off", low: "low", medium: "medium", high: "high", max: "high" },
      parseMode: "json-envelope",
      jsonTextField: "result.payloads.0.text",
      stdio: "ignore",
    },
  },

  opencode: {
    name: "OpenCode",
    role: "助理编码·免费模型",
    color: "#06b6d4",
    avatar: "⌁",
    persona: "你是群聊中的「助理编码手」。你当前的状态：\n1. 使用免费模型，能力有限，主要做辅助编码\n2. 擅长快速写出简单、可直接运行的代码\n3. 优先用标准库，代码要简洁带类型标注\n4. 复杂架构、深度分析的问题交给 Grok 或 Pi\n5. 明确知道自己能力边界，不逞强",
    cli: {
      command: "opencode",
      args: ["run", "--model", "{model}", "--format", "json", "{prompt}"],
      parseMode: "ndjson",
      textField: "part.text",
      textType: "text",
      stdio: "ignore",
    },
  },

  // ── 常见第三方 CLI：装了即自动可用 ──
  codex: {
    name: "Codex",
    role: "OpenAI 编码代理",
    color: "#10a37f",
    avatar: "◈",
    persona: "你是群聊中的 OpenAI Codex 代理。擅长按规范完成编码任务，输出简洁、可直接采用的方案与代码。",
    cli: {
      command: "codex",
      args: ["exec", "--json", "--skip-git-repo-check", "{prompt}"],
      parseMode: "ndjson",
      textType: ["agent_message", "message", "item.completed"],
      textFields: ["message", "item.text"],
      stdio: "ignore",
      timeoutMs: 300000,
    },
  },

  claude: {
    name: "Claude Code",
    role: "Anthropic 编码代理",
    color: "#d97757",
    avatar: "✳",
    persona: "你是群聊中的 Claude Code 代理。擅长严谨的工程实现、代码审查与重构建议，回答务求准确可验证。",
    cli: {
      command: "claude",
      args: ["-p", "{prompt}"],
      parseMode: "text",
      stdio: "ignore",
      timeoutMs: 300000,
    },
  },

  gemini: {
    name: "Gemini CLI",
    role: "Google Gemini 代理",
    color: "#4285f7",
    avatar: "✦",
    persona: "你是群聊中的 Gemini 代理。擅长快速给出多方案对比与综合建议，信息面广。",
    cli: {
      command: "gemini",
      args: ["-p", "{prompt}"],
      parseMode: "text",
      stdio: "ignore",
      timeoutMs: 300000,
    },
  },

  qwen: {
    name: "Qwen Code",
    role: "通义千问编码代理",
    color: "#615ced",
    avatar: "Q",
    persona: "你是群聊中的 Qwen Code 代理。中文语境能力强，擅长贴近国内场景的编码与文案任务。",
    cli: {
      command: "qwen",
      args: ["-p", "{prompt}"],
      parseMode: "text",
      stdio: "ignore",
      timeoutMs: 300000,
    },
  },
};
