---
type: codemap
project: AI·OPS COCKPIT
status: active
workflow_version: 4
updated: 2026-08-06
---

# AI·OPS COCKPIT · 代码地图

> 本文件只记录稳定的入口、目录职责、命令和风险边界。实现细节以源码为准，产品事实以 [PRODUCT.md](PRODUCT.md) 为准。

## 技术基线

- 项目形态：已有代码的 macOS 本地 Web 应用
- 当前产品版本：`2.0.0`
- 命名迁移：当前界面与包名仍保留 AI·OPS DECK；目标产品名以 [PRODUCT.md](PRODUCT.md) 为准
- 运行时：Node.js `>=18`；初始化环境为 `v24.15.0`
- 模块系统：ECMAScript Modules
- 后端：Express 4、WebSocket (`ws`)、`node-pty`
- 前端：原生 HTML、CSS、JavaScript；第三方浏览器库保存在 `public/vendor/`
- Agent 流式协议：SSE；终端协议：WebSocket
- 包管理器：npm；锁文件：`package-lock.json`
- 稳定分支：`main`
- 稳定基线：`cf62d8ffdbf8dafbce4fca8062419bf345a2a29c`
- 当前验证基线：依赖完整；62 项默认 S01 测试和 12/12 macOS 无写入 PTY 探针通过；隔离端口健康检查和桌面/窄屏页面检查通过；没有 lint、CI 或 build 脚本。

## 关键路径

| 路径 | 职责 | 分类 |
|---|---|---|
| `src/server.js` | Express、WebSocket、安全头、路由装配、启动与关闭 | 程序入口 / 组合层 |
| `src/agent-caller.js` | 输入清洗、Prompt 构建、CLI 调用和输出解析 | 核心领域 |
| `src/limits.js` | 消息、轮次、输出和请求边界 | 核心规则 |
| `src/config.js` | 内置目录与用户配置合并、CLI 可用性探测 | 配置适配层 |
| `src/agent-catalog.js` | 内置 Agent 适配器目录 | CLI 适配层 |
| `src/install-catalog.js` | 白名单安装条目与安装方式 | 安装适配层 |
| `src/routes/api.js` | 多 Agent 并行、协作、多轮与 SSE API | 应用层 |
| `src/routes/tools.js` | 工具清单、服务探活和扫描入口 | 本机适配层 |
| `src/routes/launch.js` | 应用、命令和后台进程启动 | 高权限适配层 |
| `src/routes/install.js` | 安装任务、日志、超时和状态查询 | 高权限适配层 |
| `src/routes/escort.js` | DeepSeek 凭据状态、连接检测与护航对话的认证 HTTP 契约 | 护航应用层 |
| `src/services/credential-store.js` | macOS Keychain 固定条目的安全增删改查 | 凭据适配层 |
| `src/services/escort-service.js` | 护航状态机、输入边界、并发控制与 Provider 编排 | 护航领域层 |
| `src/providers/deepseek.js` | DeepSeek 请求、超时、响应解析与稳定错误映射 | Provider 适配层 |
| `src/terminal.js` | 完整本机 PTY Shell | 高权限适配层 |
| `src/utils/auth.js` | 随机 Token、认证中间件与写盘 | 安全边界 |
| `public/` | 控制台、群聊、安装器和终端页面 | 表现层 |
| `public/js/escort.js`、`public/css/escort.css` | 常驻/移动覆盖式护航面板及安全纯文本交互 | 护航表现层 |
| `public/vendor/` | 本地化第三方前端依赖 | 第三方生成资产 |
| `test/` | Credential Store、Provider、Escort Service、路由和护航 UI 的 Node 原生测试 | 自动化验证层 |
| `scripts/` | 环境安装、工具扫描和 node-pty 权限修复 | 运维脚本 |
| `run-debate.js`、`debate.json` | 配置驱动的命令行辩论流程 | 实验性工作流 |
| `docs/` | 产品、当前版本、代码地图与想法事实源 | 项目管理层 |

S01 的护航控制面独立于 `src/agent-caller.js` 与现有 CLI 群聊：Provider → Escort Service → 认证路由 → 护航面板形成单独调用链，Pi 或其他 CLI 不可用时不会切断护航代码路径。

## 常用命令

| 用途 | 命令 | 初始化验证 |
|---|---|---|
| 安装依赖 | `npm install` | 本轮未重装；`npm ls --depth=0` 已确认完整 |
| 启动服务 | `npm start` | 临时端口 `43210` 已通过；默认 `3210` 被占用 |
| 指定端口 | `PORT=43211 npm start` | S01 验证通过 |
| 健康检查 | `curl http://127.0.0.1:43211/api/health` | 已返回 `ok: true` |
| 扫描工具 | `npm run scan` | 本轮未执行；会更新本地 `tools.json` |
| 完整安装引导 | `npm run setup` | 本轮未执行；包含环境检查、安装和扫描 |
| JavaScript 语法检查 | `git ls-files '*.js' | xargs -n1 node --check` | 初始化 28 个文件通过；S01 新增/装配文件再次通过 |
| 自动化测试 | `npm test` | 62 项通过；`RUN_MACOS_KEYCHAIN_PROMPT_PROBE=1 node --test test/credential-store.test.js` 另有 12/12 无写入 macOS 探针 |
| lint | 未配置 | 不可用 |
| build | 无需前端构建，且未配置 build 脚本 | 不适用 |

## 验证与交付策略

- 结构校验：`node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs .`；进入开工、完成、合并、发布或归档前增加 `--strict`。
- 当前基础证据：依赖树、逐文件 JavaScript 语法检查、隔离端口健康检查。
- S01 起新增：Node.js 原生 test runner；优先测试纯适配器与服务边界，不为一个切片引入大型测试框架。
- 外部系统或真实凭据不能只靠 Mock 宣称完成；DeepSeek 和 Keychain 必须保留一条不暴露秘密的本机人工验收路径。
- 完成结论必须能追溯到 [NOW.md](NOW.md) 的“需求—证据映射”；结构校验通过不等于产品行为通过。

## 版本控制边界

### 当前 Git 状态

- 远程仓库：`origin` → `git@github.com:wbyan2021/pullic-talk.git`
- 稳定分支：`main`
- S01 工作分支 `codex/v0.1-s01-escort-online` 已于 2026-08-06 fast-forward 合并入 `main`（新基线 `cf62d8ffdbf8dafbce4fca8062419bf345a2a29c`）并删除；S02 分支待 Ready 后创建。
- 当前唯一保留为未提交用户资产的是 `.gitignore` 中的 `.superpowers/` 规则，不覆盖、不暂存、不丢弃。
- 产品代码使用 `codex/<版本>-<切片>-<短名称>`；同一时间只保留一个产品工作分支。

### 必须提交

- `src/`、`public/`、`scripts/` 中的项目源码和必要第三方本地资产
- `package.json`、`package-lock.json`
- `agents.config.json`、`debate.json` 等不含秘密的配置
- `README.md`、`LICENSE`、`AGENTS.md`、`docs/`

### 必须忽略或谨慎处理

- `node_modules/`、`.DS_Store`、`.aider*`、`__pycache__/`、`*.pyc`
- `tools.json`、`.token`、`.env`、`logs/`、`*.log`、`debates/`
- 任何真实令牌、密码、私钥、账号凭据、本地数据库和个人数据

### 生成与保护规则

- `.token`：认证秘密，只允许程序生成；禁止读取、展示和提交。
- `tools.json`：本机扫描结果，由 `npm run scan` 更新；不纳入 Git。
- `node_modules/`：依赖目录，只由 npm 管理。
- `package-lock.json`：只随依赖安装或升级变化，不手工编辑。
- `public/vendor/`：第三方本地化资产，普通功能切片不修改。

## 生成内容与副作用

| 动作 | 可能副作用 | 执行规则 |
|---|---|---|
| `npm install` / `npm run setup` | 修改依赖、锁文件、node-pty 权限或本机环境 | 仅在计划明确需要且用户授权后执行 |
| `npm run scan` | 重写本机 `tools.json` | 只用于真实扫描验收，不纳入提交 |
| `npm start` | 生成/覆盖 `.token`，监听本地端口 | 使用隔离端口；禁止读取或展示 `.token` |
| 安装/启动/终端接口 | 安装软件、启动进程或执行当前用户权限命令 | 必须遵守白名单、用户授权和进程归属边界 |
| S01 凭据操作 | 增改或删除 macOS Keychain 中固定服务条目 | 只通过明确 UI 动作；Key 不进 argv、文件或日志；删除必须幂等 |

S01 使用的固定 Keychain 标识为 service `com.ai-ops.cockpit.provider.deepseek`、account `default`。保存通过既有 `node-pty` 等待 C-locale 固定提示并写入，写入后不保留 PTY 输出；查询、读取和删除仍使用无 shell 的普通子进程。自动化测试使用假 Key；macOS 提示探针在输入前终止并确认不生成条目。真实副作用必须由用户在网页验收时主动触发。

## 高风险区域

| 路径或依赖 | 风险 | 修改前检查 |
|---|---|---|
| `src/terminal.js` | 提供当前 macOS 用户权限下的完整 Shell | Origin、Token、输入上限、确认与退出清理 |
| `src/routes/launch.js` | 可以启动应用和本机命令 | 参数边界、危险模式、用户确认和进程回收 |
| `src/routes/install.js`、`src/install-catalog.js` | 调用包管理器和外部安装源 | 白名单、来源、超时、重复任务和失败提示 |
| `src/agent-caller.js` | CLI 在用户主目录运行并继承环境变量 | 工作目录、参数注入、输出上限、超时和停止 |
| `src/utils/auth.js`、`src/server.js` | 本地控制面的认证与暴露边界 | Token、Origin、监听地址、CSP、速率限制 |
| `src/services/credential-store.js` | 接触真实 Provider Key 与系统钥匙串 | 绝对命令路径、shell 禁用、受控 PTY 固定提示、输出边界、超时回收、无明文回退 |
| `src/providers/deepseek.js`、`src/routes/escort.js` | 付费外部请求与错误/秘密泄露 | 超时、单并发、频率、状态字段白名单、原始错误不透传 |
| `public/js/chat.js` | 单文件较大，状态、DOM 与流式逻辑耦合 | XSS、会话兼容、停止流程和现有交互回归 |
| `agents.config.json` | 可改变真实 CLI 命令和参数 | 不含秘密、命令合法、输出解析契约可验证 |
| 外部 AI CLI | 版本、登录和输出格式随上游变化 | 版本探测、最小真实调用和失败降级 |

## 已知工程缺口

- 已有 62 项默认 S01 自动化测试和一个需显式启用的 macOS 无写入 PTY 探针，但还没有 CI、lint 和全产品回归测试；旧控制台、安装、群聊和终端主要仍依赖语法与人工回归。
- `public/js/chat.js` 体量较大，修改容易产生跨功能回归。
- Agent 默认工作目录是用户主目录，不具备项目级 Workspace 边界。
- 默认端口 `3210` 在初始化时已被未知进程占用。
- DeepSeek 与 macOS Keychain 的真实验收尚未完成；Mock 证据不能替代用户自己的 Key 和本机授权策略。

## 维护规则

只有程序入口、目录职责、常用命令、生成规则、保护边界或稳定基线发生变化时才更新本文件。不要复制代码内容，也不要逐文件写说明。
