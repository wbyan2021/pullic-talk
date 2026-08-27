---
type: codemap
project: AI·OPS COCKPIT
status: active
workflow_version: 4
updated: 2026-08-26
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
- 稳定基线：`8a72e99`
- 当前验证基线：依赖完整；`node --test` 299/299 通过；逐文件语法、差异和 strict 结构检查通过。S04 用户功能验收已于 2026-08-26 确认；S05-A 只读总览与 S05-B 安全恢复已于 2026-08-28 通过用户页面验收并收口为 done；文件回退与多任务并行仍未实现。没有 lint、CI 或 build 脚本。

## 关键路径

| 路径 | 职责 | 分类 |
|---|---|---|
| `src/server.js` | Express、WebSocket、安全头、路由装配、启动与关闭 | 程序入口 / 组合层 |
| `src/agent-caller.js` | 输入清洗、Prompt 构建、CLI 调用和输出解析 | 核心领域 |
| `src/limits.js` | 消息、轮次、输出和请求边界 | 核心规则 |
| `src/config.js` | 内置目录与用户配置合并、成员配置原子写回/热加载、CLI 可用性探测 | 配置适配层 |
| `src/agent-catalog.js` | 内置 Agent 适配器目录 | CLI 适配层 |
| `src/install-catalog.js` | 白名单安装条目与安装方式 | 安装适配层 |
| `src/routes/api.js` | 多 Agent 并行、协作、多轮、实际模型元数据与 SSE API | 应用层 |
| `src/routes/members.js` | Agent 成员列表、模型配置、启用/停用、自定义成员增删的认证 HTTP 契约 | 群聊配置应用层 |
| `src/routes/secrets.js` | 实验性 `~/.secrets.env` Key 快照与写入的认证 HTTP 契约 | 高风险凭据适配层 |
| `src/routes/tools.js` | 工具清单、服务探活和扫描入口 | 本机适配层 |
| `src/routes/launch.js` | 应用、命令和后台进程启动 | 高权限适配层 |
| `src/routes/install.js` | 安装任务、日志、超时和状态查询 | 高权限适配层 |
| `src/routes/escort.js` | DeepSeek 凭据状态、连接检测与护航对话的认证 HTTP 契约 | 护航应用层 |
| `src/services/credential-store.js` | macOS Keychain 固定条目的安全增删改查 | 凭据适配层 |
| `src/services/escort-service.js` | 护航状态机、输入边界、并发控制与 Provider 编排 | 护航领域层 |
| `src/providers/deepseek.js` | DeepSeek 请求、超时、响应解析与稳定错误映射 | Provider 适配层 |
| `src/routes/project.js` | 项目选择、只读识别、刷新与移除的认证 HTTP 契约 | 项目应用层 |
| `src/services/git-inspector.js` | 只读 Git 适配器：命令白名单、超时、输出截断与路径安全 | 项目适配层 |
| `src/services/project-boundary.js` | 项目选择状态机、`projects.local.json` 持久化与失效检测 | 项目领域层 |
| `src/services/pi-executor.js` | Pi 受控执行：auth 检查、spawn（cwd=活动项目）、NDJSON 流式解析、停止、超时与进程清理 | 执行适配层 |
| `src/routes/execution.js` | Pi 运行状态、SSE 启动流与停止的认证 HTTP 契约 | 执行应用层 |
| `public/js/project.js`、`public/css/project.css` | 多项目列表、活动项目切换，以及单一 Pi 面板的项目卡片挂载 | 项目表现层 |
| `public/js/execution.js`、`public/css/execution.css` | 项目 view 内 Pi 运行面板：风险确认、流式输出、停止、状态灯，并随活动项目变化刷新边界 | 执行表现层 |
| `public/js/overview.js`、`public/css/overview.css` | 顶层只读总览四卡片、双语状态映射、可见时轮询和项目页跳转 | 总览表现层 |
| `src/services/safe-redactor.js` | Key、Token、密码、私钥、Bearer 和环境变量形态的统一脱敏 | 安全边界 |
| `src/services/blackbox-store.js` | 项目外追加式 JSONL 事件、终态、恢复和截断行容错 | 黑匣子领域层 |
| `src/services/task-evidence.js` | Pi 生命周期、Git 前后快照、文件变化分类、验证和验收状态协调 | 黑匣子领域层 |
| `src/services/task-recovery.js` | 失败/中断任务资格判断、短时预览指纹、二次确认、新批次重启编排与旧记录追加关联 | 高风险恢复领域层 |
| `src/services/validation-runner.js` | 用户批准的结构化 executable + argv 验收命令；shell=false、活动项目 cwd、超时和输出上限 | 高风险适配层 |
| `src/services/ai-handoff.js` | 目标项目 `docs/ai-ops/` 当前交接与一次性历史记录的脱敏原子写入，以及只读摘要解析 | AI 交接适配层 |
| `src/routes/evidence.js` | 证据状态、验收命令预览/执行、accepted/needs_review 收口契约 | 黑匣子应用层 |
| `src/routes/overview.js` | 当前项目、执行、证据和 AI 交接的认证只读聚合契约；严格字段投影 | 总览应用层 |
| `src/routes/recovery.js` | 恢复状态、预览和确认启动的认证 HTTP 契约；稳定错误码与字段白名单 | 高风险恢复应用层 |
| `docs/ai-ops/NOW.md`、`docs/ai-ops/records/` | 写入目标项目的 AI 当前交接和历史记录；必须由用户显式启用 | 目标项目数据 |
| `src/terminal.js` | 完整本机 PTY Shell | 高权限适配层 |
| `src/utils/auth.js` | 随机 Token、认证中间件与写盘 | 安全边界 |
| `src/utils/secrets-env.js` | 本地 `export KEY=value` 文件解析、原子写回、shell 单引号转义和 `0600` 尝试 | 高风险凭据适配层 |
| `public/` | 控制台、群聊、安装器和终端页面 | 表现层 |
| `public/js/members.js`、`public/css/members.css` | 群聊成员与模型维护面板 | 群聊表现层 |
| `public/js/secrets.js`、`public/css/secrets.css` | 实验性本地 Key 管理面板；密码输入、显示/隐藏和增删改 | 高风险凭据表现层 |
| `public/js/escort.js`、`public/css/escort.css` | 常驻/移动覆盖式护航面板及安全纯文本交互 | 护航表现层 |
| `public/vendor/` | 本地化第三方前端依赖 | 第三方生成资产 |
| `test/` | Credential Store、Provider、Escort、成员/Key 路由、项目执行、聊天与 UI 的 Node 原生测试 | 自动化验证层 |
| `scripts/` | 环境安装、工具扫描和 node-pty 权限修复 | 运维脚本 |
| `run-debate.js`、`debate.json` | 配置驱动的命令行辩论流程 | 实验性工作流 |
| `docs/` | 产品、当前版本、代码地图与想法事实源 | 项目管理层 |

S01 的护航控制面独立于 `src/agent-caller.js` 与现有 CLI 群聊：Provider → Escort Service → 认证路由 → 护航面板形成单独调用链，Pi 或其他 CLI 不可用时不会切断护航代码路径。

## 常用命令

| 用途 | 命令 | 初始化验证 |
|---|---|---|
| 安装依赖 | `npm install` | 本轮未重装；`npm ls --depth=0` 已确认完整 |
| 启动服务 | `npm start` | 使用隔离端口完成本轮健康检查；默认 `3210` 是否可用以现场状态为准 |
| 指定端口 | `PORT=43211 npm start` | S01 验证通过 |
| 健康检查 | `curl http://127.0.0.1:43211/api/health` | 本轮需由用户确认页面可打开并返回 `ok: true` |
| 扫描工具 | `npm run scan` | 本轮未执行；会更新本地 `tools.json` |
| 完整安装引导 | `npm run setup` | 本轮未执行；包含环境检查、安装和扫描 |
| JavaScript 语法检查 | `git ls-files '*.js' | xargs -n1 node --check` | 初始化 28 个文件通过；S01 新增/装配文件再次通过 |
| 自动化测试 | `npm test` | 299 项定义；本轮 `node --test` 299/299；包含 S05-A 总览与 S05-B 恢复路由、资格/指纹/脱敏/集成和 UI 合约测试 |
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
- S01、S02、S02b 与 S03 工作分支均已 fast-forward 合并入 `main`（当前基线 `8a72e99`）并删除；S04 用户已确认功能验收通过；S05-A/S05-B 已于 2026-08-28 通过用户页面验收，工作分支 `codex/v0.1-s05-overview-readonly` 按惯例 fast-forward 合并入 `main` 并删除；文件回退与多任务并行不在范围内。
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
- `projects.local.json`：S02 项目选择状态，由项目边界服务写入仓库根；不含秘密，已加入 `.gitignore`。
- `blackbox.local/`：S04 本地黑匣子事件目录，由黑匣子服务追加写入；已加入 `.gitignore`，不提交。
- `docs/ai-ops/`：用户显式启用后才写入目标项目；当前文件原子更新，历史记录不可覆盖；内容必须经过统一脱敏。
- `~/.secrets.env`：实验性网页 Key 管理目标文件；不提交、不读取真实内容、不把它当作 Keychain 等价物；当前实现只在保存后同步服务进程，重启加载不由本应用保证。
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
| 群聊成员维护 | 写回 `agents.config.json` 并触发配置热加载 | 只允许白名单字段；损坏配置保留旧配置；不要覆盖用户未分类改动 |
| 实验性 Key 管理 | 通过认证 API 写回 `~/.secrets.env` 并同步当前 `process.env` | 高风险；不读取/输出真实值；浏览器会收到当前值，必须单独安全审查 |

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
| `src/routes/secrets.js`、`src/utils/secrets-env.js`、`public/js/secrets.js` | 网页读取和写入本地 Key 文件，并可能把值展示到浏览器 | 认证闸门、变量名/长度白名单、原子写入、0600、浏览器暴露风险；未完成 S01 等级验收前不作为默认凭据路径 |
| `src/routes/members.js`、`src/config.js`、`public/js/members.js` | 修改 Agent 成员和模型配置并热加载 | 字段白名单、原子写入、禁用/自定义语义、配置损坏回退和并发写入审查 |
| `src/providers/deepseek.js`、`src/routes/escort.js` | 付费外部请求与错误/秘密泄露 | 超时、单并发、频率、状态字段白名单、原始错误不透传 |
| `src/services/git-inspector.js`、`src/routes/project.js` | 任意路径输入与 Git 子进程 | 只读命令白名单、无 shell、超时、输出截断、realpath 校验、禁止根 |
| `src/services/pi-executor.js`、`src/routes/execution.js`、`src/services/task-recovery.js`、`src/routes/recovery.js` | Pi 在活动项目内以完整用户权限执行及失败/中断恢复 | 无 shell、argv 永不含密钥、cwd 限定活动项目 repoRoot、SIGTERM+超时回收、单实例 busy、恢复预览指纹和二次确认；不回退文件 |
| `src/services/validation-runner.js`、`src/routes/evidence.js` | 用户批准的验收命令可能执行任意项目测试 | 只接受结构化 executable/argv；禁止 shell 语法和环境赋值；cwd 必须是活动项目；超时、输出上限、stderr 丢弃、结果分层 |
| `src/services/ai-handoff.js`、`src/services/blackbox-store.js` | 任务事实写入项目文件和本机记录 | 统一脱敏、原子当前文件、历史不可覆盖、追加 JSONL、截断/恢复安全、未验证事实不得伪装 verified |
| `public/js/chat.js` | 单文件较大，状态、DOM 与流式逻辑耦合 | XSS、会话兼容、停止流程和现有交互回归 |
| `agents.config.json` | 可改变真实 CLI 命令和参数 | 不含秘密、命令合法、输出解析契约可验证 |
| 外部 AI CLI | 版本、登录和输出格式随上游变化 | 版本探测、最小真实调用和失败降级 |

## 已知工程缺口

- 已有 299 项默认自动化测试和一个需显式启用的 macOS 无写入 PTY 探针，但还没有 CI、lint 和全产品回归测试；本轮包含恢复集成/安全路径与隔离端口认证检查；此前沙箱不能监听 loopback，成员/Key 路由已在受限环境外复跑并记录通过。
- `public/js/chat.js` 体量较大，修改容易产生跨功能回归。
- Agent 默认工作目录是用户主目录，不具备项目级 Workspace 边界。
- 默认端口 `3210` 曾被早于 S01 的旧实例占用；2026-08-06 已查明并经用户授权结束，现运行 S01 合并后的代码。
- DeepSeek 与 macOS Keychain 的真实验收尚未完成；Mock 证据不能替代用户自己的 Key 和本机授权策略。
- 网页 Key 管理是新增的实验性高风险路径：当前 API 返回 Key 值给已认证浏览器，且服务启动不会自动解析 `~/.secrets.env`；需要先完成安全边界决策和真实验收，不能与 S01 Keychain 证据混用。
- 成员/模型维护已能写回配置并热加载，但尚未完成用户页面验收；`agents.config.json` 中的本机启用/停用状态不是产品基线。

## 维护规则

只有程序入口、目录职责、常用命令、生成规则、保护边界或稳定基线发生变化时才更新本文件。不要复制代码内容，也不要逐文件写说明。
