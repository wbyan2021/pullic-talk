# AI·OPS DECK

> 桌面 AI 工具控制中心 — 一键启动 CLI / 内嵌终端 / 多 AI 群聊

![macOS](https://img.shields.io/badge/macOS-supported-brightgreen) ![node](https://img.shields.io/badge/node-%3E%3D18-blue)

## ✨ 特性

- 🎛 **工具控制台**：自动扫描本机装了哪些 AI CLI（codex / grok / pi / opencode…）和桌面 App，一键启动
- 💻 **内嵌终端**：全屏 xterm.js 终端，直接执行任意 shell 命令
- 👥 **AI 群聊**：多个 agent 同屏对话，支持派子代理并行
- 🔒 **默认只监听 127.0.0.1**，终端拥有完整 shell 权限，不对外暴露

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
│   ├── server.js          # Express + WebSocket 主入口
│   ├── terminal.js        # 内嵌终端（node-pty）
│   ├── agent-caller.js    # AI agent 调用层
│   └── routes/            # /api/tools /api/launch /api/procs …
├── public/
│   ├── index.html         # 控制台主页
│   ├── chat.html          # 群聊页
│   ├── terminal.html      # 全屏终端页
│   └── css/  js/
├── scripts/
│   ├── setup.sh           # 一键安装
│   ├── scan-tools.js      # 扫描本机工具
│   └── fix-node-pty.js    # 修 spawn-helper 执行位（postinstall 自动跑）
├── tools.json             # 扫描结果（本机相关，仅供参考，新电脑上要重扫）
├── agents.config.json     # AI agent 配置
└── package.json
```

---

## 🛡 安全

- 终端 WebSocket 只接受 origin = `127.0.0.1` / `localhost`
- HTTP 服务默认只监听 `127.0.0.1`（改绑 `0.0.0.0` 需自行设置 `HOST` 环境变量）
- CSP 头限制脚本来源
- 命令启动接口有危险模式黑名单（`rm -rf` / `mkfs` / `dd` / `shutdown` 等）
- 每 IP 每分钟 200 次请求速率限制

---

## 📝 License

MIT
