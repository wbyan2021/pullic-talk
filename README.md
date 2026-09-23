# AI·OPS DECK

> 桌面 AI 工具控制中心 — 一键启动 CLI / 内嵌终端 / 多 AI 群聊

![macOS](https://img.shields.io/badge/macOS-supported-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D18-blue)

## ✨ 特性

- 🎛 **工具控制台**：自动扫描本机装了哪些 AI CLI（codex / grok / pi / opencode…）和桌面 App，一键启动
- ⬇ **快捷安装**：AI 基础环境（Node / Git / Python / uv）、最热编码 Agent（Claude Code / Codex / Gemini CLI / Qwen Code…）与热门 AI 应用一键装，附大模型官网导航（官方渠道，Homebrew / npm / 官网下载）
- 💻 **内嵌终端**：全屏 xterm.js 终端，直接执行任意 shell 命令
- 👥 **AI 群聊**：多个 agent 同屏对话，**自动识别本机装了哪些 CLI**，没装的灰显并可一键安装；支持 @定向、并行/协作、多轮讨论、消息头显示实际模型、一键重新生成最后一轮
- 🔑 **本地 Key 管理**：群聊页可直接管理 `~/.secrets.env`（增删改 API Key），保存后立即写入文件并热更新到当前服务进程；浏览器只见掩码不回显明文，重启服务自动加载
- 🔒 **默认只监听 127.0.0.1** + 随机 token 认证，终端拥有完整 shell 权限但不对外暴露

---

## 🚚 换电脑了？AI 不一样？不用管

群聊不绑定固定配置：

1. 服务端内置 **agent 适配器目录**（`src/agent-catalog.js`）：grok / pi / openclaw / opencode / codex / claude / gemini / qwen
2. 启动时自动探测每个 CLI 是否在本机 PATH（`/api/models` 返回 `available` 字段）
3. 新电脑装了哪些，群聊里就亮哪些；没装的灰显为「未安装 ⬇」，点一下直接装
4. `agents.config.json` 是**自定义覆盖层**：同名条目可只覆盖部分字段（比如 model / models / enabled），也可以加你自己的私有 agent；`"enabled": false` 表示把该成员停用（不出现在群聊里）

想支持新的 CLI？在 `src/agent-catalog.js` 加一个适配器条目即可（command / args / 输出解析方式）。

---

## 💬 群聊使用要点

- **@定向**：输入 `@codex` 只发给 Codex，`@all` 发给全部启用的 agent；纯文本发给当前启用的 agent
- **模式**：并行（同时回答）/ 协作（依次发言，后者能看到前者）；可设 1–5 轮多轮讨论
- **模型**：每个 agent 头像上可单独切换模型；发言时消息头会标注该次实际使用的模型
- **🔄 重新生成**：对最后一轮回复不满意时点输入栏右侧 🔄，按原始输入（含 @定向）截断重发
- **上下文**：发给 agent 的历史不包含当前消息（避免 prompt 重复拼接），服务端另有去重兜底
- **👥 成员维护**：群聊页右上角「👥」打开成员面板，可启用/停用成员、修改每个成员的默认模型与可选模型列表、添加自定义 CLI 成员、删除自定义成员；改动会写入 `agents.config.json` 并热生效
- **🔑 Key 管理**：群聊页右上角「🔑 Key」打开本地 API Key 管理面板，可增删改 `~/.secrets.env` 里的 Key；保存后同步当前服务进程，重启服务自动加载（不覆盖启动时已显式设置的同名变量）。浏览器只显示掩码、不回显明文，已有条目「留空 = 保持不变」。本面板仅用于群聊成员/自定义 CLI 的 Key；DeepSeek 护航 Key 请使用 macOS Keychain 路径

---

## 🚀 新电脑一键安装

```bash
# 1. 拉取代码
git clone git@github.com:wbyan2021/pullic-talk.git
cd pullic-talk

# 2. 一键安装（检测环境 + 装依赖 + 扫描工具 + 可选启动）
npm run setup
```

`setup.sh` 会自动完成：

| 步骤 | 说明 |
|---|---|
| ① 系统检查 | 仅支持 macOS |
| ② Node.js 检查 | 需要 v18+，缺失会给出安装指引 |
| ③ Xcode CLT 检查 | `node-pty` 编译依赖，缺失会触发安装弹窗 |
| ④ 依赖安装 | `npm install`，含 postinstall 修复 spawn-helper 权限 |
| ⑤ 端口检查 | 默认 3210，占用时给出提示 |
| ⑥ 首次扫描 | 生成本机的 `tools.json` |
| ⑦ 询问启动 | 回车立即 `npm start` |

---

## 手动安装（如果不想跑脚本）

```bash
npm install    # 会自动跑 postinstall
npm run scan   # 扫描本机工具（生成 tools.json）
npm start      # 浏览器打开 http://localhost:3210
```

指定其他端口：`PORT=8888 npm start`

---

## 📦 前置要求

- **macOS**（Windows / Linux 未支持）
- **Node.js ≥ 18**（推荐 v20 / v24）
- **Xcode Command Line Tools**（`xcode-select --install`）
- 想用哪些 AI CLI 得**自己先装好**（本项目只做启动器，不代包安装 codex / pi / grok 等）

---

## 🔄 常用命令

```bash
npm start        # 启动服务
npm run scan     # 重新扫描本机工具（也可以在页面点右上角 ⟳）
npm run setup    # 重新走一遍安装流程
```

---

## 🌐 网络问题（国内用户）

如果 `git clone git@github.com:...` 卡住，说明 SSH 22 被墙。两种解法：

**A. 换 HTTPS**：
```bash
git clone https://github.com/wbyan2021/pullic-talk.git
```

**B. SSH 走 443**（推荐，一次配置终身受用）：
```bash
cat >> ~/.ssh/config <<'EOF'

Host github.com
  HostName ssh.github.com
  Port 443
  User git
EOF
chmod 600 ~/.ssh/config
```

---

## 📁 目录结构

```
pullic-talk/
├── src/
│   ├── server.js            # Express + WebSocket 主入口（token 注入 / 认证闸门）
│   ├── terminal.js          # 内嵌终端（node-pty）
│   ├── agent-caller.js      # AI agent 调用层
│   ├── agent-catalog.js     # 内置 agent 适配器目录（装了哪个 CLI 亮哪个）
│   ├── install-catalog.js   # 快捷安装目录（热门 AI 应用 / CLI）
│   ├── config.js            # 配置合并（含 enabled 停用/部分覆盖）+ CLI 可用性探测
│   ├── utils/
│   │   ├── auth.js          # 随机 token 生成与校验
│   │   └── secrets-env.js   # ~/.secrets.env 本地读写（掩码快照 + 启动自动加载）
│   ├── services/            # 护航/项目边界/执行/证据/黑匣子等后端服务
│   └── routes/              # api / tools / launch / install / members / secrets
├── public/
│   ├── index.html         # 控制台主页（含「快捷安装」页签）
│   ├── chat.html          # 群聊页（👥 成员维护 / 🔑 Key 管理）
│   ├── terminal.html      # 全屏终端页
│   ├── vendor/            # 本地化第三方库（marked/hljs/purify/xterm）
│   └── css/  js/          # chat/members/secrets/execution/project …
├── scripts/
│   ├── setup.sh           # 一键安装
│   ├── scan-tools.js      # 扫描本机工具
│   └── fix-node-pty.js    # 修 spawn-helper 执行位（postinstall 自动跑）
├── tools.json             # 扫描结果（本机相关，不入库，新电脑自动重扫）
├── .token                 # 认证 token（启动时自动生成，不入库）
├── agents.config.json     # AI agent 自定义覆盖层
└── package.json
```

---

## 🛡 安全模型

- **随机 token 认证**：启动时生成 24 字节随机 token，写入项目根 `.token`（0600，已 gitignore）；服务端渲染页面时注入 `window.__OPS_TOKEN__`，所有敏感 API 和终端 WebSocket 都校验它——恶意网页无法跨域读到 token，CSRF 打不进来
- **Host 校验（防 DNS 重新绑定）**：默认绑定时，HTTP 请求的 Host 必须是 `127.0.0.1`/`localhost`/`::1`，攻击者域名解析到本机也会被 403；`HOST` 显式改绑非回环地址时跳过此检查（局域网部署的明确选择）
- HTTP 服务默认只监听 `127.0.0.1`（改绑 `0.0.0.0` 需自行设置 `HOST` 环境变量，不建议）
- 终端 WebSocket：origin 检查 + token 双重校验，单帧上限 1MB
- `/terminal?run=` 命令注入**必须用户在弹框确认后**才执行（防恶意链接借刀杀人）
- 快捷安装只接受**白名单条目**，命令全部来自目录常量，不接受任意用户输入
- 前端第三方库全部本地化（`public/vendor/`），无 CDN 供应链风险；Markdown 在 DOMPurify 可用时消毒，缺失时的降级路径不能宣称为纯文本安全边界
- CSP 头限制资源来源（script 仅 'self'）
- 命令启动接口有危险模式黑名单（`rm -rf` / `mkfs` / `dd` / `shutdown` 等）——注意这只是误操作防护、不是安全边界，终端本身就是完整 shell
- 每 IP 每分钟 200 次请求速率限制
- 「🔑 Key」面板位于认证 API 之后，但当前会把 Key 值返回给已认证浏览器并允许临时显示；它不等同于 macOS Keychain，尚未完成同等级安全验收

命令行工具（如 `run-debate.js`）从 `.token` 文件读取 token 自动携带。

---

## 📝 License

MIT
