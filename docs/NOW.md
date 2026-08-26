---
type: milestone
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
status: active
stage: build
current_slice: S05-recovery-and-overview
slice_status: active
work_branch: codex/v0.1-s05-overview-readonly
base_commit: b71bb50
risk_level: high
last_verified_commit: b29b191
updated: 2026-08-26
---

# 当前版本：v0.1 · 第一次可控任务

> S01、S02、S02b、S03 均已通过用户验收并合并入 `main`。S04 已完成实现、自动化验证和用户功能验收，于 2026-08-26 收口为 done。S05-A「只读任务总览」设计与实施计划已获用户确认，达到 Definition of Ready；当前仅在 `codex/v0.1-s05-overview-readonly` 开发。恢复与并行任务仍不在本切片范围内。当前分支另外包含群聊成员/模型维护、实验性本地 Key 管理、项目页双语和发送体验修复；这些变化已纳入文档事实，但不改变 S04 的验收结论。

## 产品基线

- 状态：`accepted`
- 事实源：[PRODUCT.md](PRODUCT.md)
- 已确认：产品定位、核心闭环、八模块唯一所有权、当前版本目标与非目标。
- 当前切片没有改变产品基线；若把第二 Provider、Pi 配置、项目任务或远程能力带入 S01，必须先退回基线/版本范围重新确认。

## 版本目标

让用户在 AI 护航下，使用一个 Pi Agent 在一个 Git 项目中完成一条真实任务；全过程可观察、可暂停、可验证、可恢复。

## 核心闭环

```text
接通 DeepSeek 与护航 AI
→ 选择一个 Git 项目并建立安全边界
→ Pi 在项目内执行一条明确任务
→ 用户观察、暂停、继续或终止
→ 用文件变化与测试等证据验收
→ 黑匣子保留记录，必要时恢复
```

## 当前范围

- macOS 本地网页驾驶舱；
- DeepSeek 作为第一个 Provider，护航 AI 与 Pi 调用链相互独立；
- Pi 作为第一个执行 Agent；
- 多个由用户主动选择并管理的 Git 项目（录入、查看、刷新、移除；单次任务仍只在一个项目内执行）；
- 一条任务及一个受控执行批次；
- 最小统一状态与事件、项目边界、恢复点、飞行控制、验收证据和黑匣子记录。

## 明确不做

- 不做多 Agent 正式任务编排；现有群聊保留，但不进入 v0.1 主闭环。
- 不做非 Git 项目的完整快照恢复。
- 不做远程控制、移动端、插件生态、跨平台或团队协作。
- 不做完整 AI IDE、通用 AI 工具箱或云端模型托管。
- 不重写现有 Node / Express / WebSocket / SSE / node-pty 技术栈。

## 风险等级与验证策略

**当前 S05-A 处于 build/ready。** S01–S04 的风险与验收记录保留在下方；S04 的自动化、脱敏、恢复、临时真实 Git 项目闭环和用户功能验收均已记录。S05-A 只读总览先复用已有事实源；恢复点、文件回退和多任务并行仍需独立设计。

| 依赖 | 风险 | 当前证据 | 后续最小验证 |
|---|---|---|---|
| macOS 钥匙串 | 系统授权策略与 `security` 的 TTY 行为可能因本机环境不同 | 11 项默认测试与 12/12 无写入 macOS 探针验证固定条目、受控 PTY 提示、幂等删除、无明文回退和超时回收；首次真实保存发现并修复普通 stdin 缺陷 | 用户刷新修复后的网页，完成一次保存、替换、删除，并在 Keychain Access 核对固定条目 |
| DeepSeek API | 错误协议、模型可用性和真实网络状态可能变化 | 13 项 Provider 测试已覆盖成功、401/402/429/5xx、网络、超时和非法响应；均为假 Key/Mock | 用户用自己的 Key 完成连接检测和一次真实护航回复 |
| Pi CLI | 登录、模型配置、输出格式和停止行为可能变化 | 当前代码能发现 CLI，但未形成受控任务契约 | S03 前固定版本并做最小真实调用 |
| 本机 Shell 与子进程 | 继承当前用户权限，不是真正沙箱 | 当前已有 node-pty 和命令启动能力 | 明确工作目录、子进程归属、暂停与终止语义 |
| Git 工作区 | 用户可能已有分支、未提交改动和未跟踪文件 | 当前仓库本身已有未知改动 | S02 先验证只读识别和保护策略 |
| 自动化验证 | 暂无 CI 和 lint，外部服务不能由 Mock 代替 | 当前候选实现 210/210 默认测试、语法与差异检查通过；含临时真实 Git 项目端到端、恢复、argv-only 命令、跨平台 realpath 校验、停止后 SSE 收口和活动项目 Pi 面板挂载回归 | 运行隔离端口健康检查，并由用户完成真实页面验收；后续版本再评估 CI |
| S04 项目交接写入与验收命令 | high | 已实现显式启用、脱敏原子写入、追加黑匣子、Git 前后快照、Pi 生命周期、argv-only 验收命令、失败/恢复和安全路由；用户已于 2026-08-26 确认功能验收通过 | 切片已 done；后续只处理发现的缺陷，不重新扩大 S04 范围 |
| S05 恢复与总览闭环 | high | S05-A 只读总览已完成设计与 Definition of Ready；恢复语义仍未设计 | 先实现并验收 S05-A；恢复与文件回退另行设计 |
| 实验性网页 Key 管理 | high | `/api/secrets`、`~/.secrets.env` 原子写入与 0600 尝试；`secrets-routes` 4 项路由测试在受限环境外通过 | 需要用户确认是否纳入 v0.1，并完成浏览器暴露、重启加载和真实凭据安全审查；不能与 S01 Keychain 证据混用 |
| 群聊成员/模型维护 | medium | 成员路由、配置合并/热加载和静态 UI 测试已加入当前分支 | 用户页面验收启用/停用、模型编辑、自定义成员增删；本机配置状态不等于产品基线 |
| 默认端口 3210 | 曾被 7 月 31 日的旧实例占用 | 2026-08-06 经用户授权结束旧实例（PID 25068），S01 合并后的服务已在 3210 正常运行 | 无需进一步处理 |

验证深度：

1. 单元测试覆盖 Keychain 调用边界、Key 不进入命令参数、DeepSeek 响应与错误归类。
2. 语法、差异和隔离端口健康检查覆盖装配回归。
3. 用户在网页中完成一次真实 Key 保存、连接检测、护航回复、替换与删除验收；Key 不通过聊天或终端交给 AI。
4. 若真实服务、钥匙串权限或错误协议与设计不一致，切片退回 `candidate`，不得用“测试里模拟成功”代替真实证据。

## 版本验收标准

- [x] 用户可安全配置 DeepSeek，并独立使用护航 AI。
- [x] 用户可录入并管理多个 Git 项目，既有改动不会被覆盖或丢弃。
- [x] Pi 只能在已选择的项目边界内开始受控任务。
- [ ] 用户可观察状态，并能安全暂停、继续和终止执行。
- [ ] 完成结果包含文件变化、命令或测试等可检查证据。
- [ ] 任务全过程生成脱敏记录，并可从明确恢复点恢复。
- [ ] 用户实际完成一条真实任务，而不只是看到功能演示。

## 计划切片

| 顺序  | 切片         | 可观察结果                        | 状态        |
| --- | ---------- | ---------------------------- | --------- |
| S01 | 护航 AI 独立上线 | 配置 DeepSeek 后能检测连接、对话并显示可靠状态 | done      |
| S02 | Git 项目安全边界 | 选择项目后识别并保护现有工作区状态            | done |
| S02b | 多项目并行管理 | 可同时录入多个 Git 项目，列表查看、刷新、移除，并指定活动项目 | done   |
| S03 | Pi 受控运行    | Pi 只在活动项目内启动，并可暂停、继续、终止        | done   |
| S04 | 证据与黑匣子     | 可查看状态时间线、文件变化和验收证据           | done   |
| S05 | 恢复与总览闭环    | 可恢复到检查点，并从总仪表完成整条任务          | active   |

## 代码工作区

- 代码地图：[CODEMAP.md](CODEMAP.md)
- 稳定分支：`main`
- 稳定基线：`8a72e99`（S01 + S02 + S02b + S03 均已 fast-forward 合并入 main）
- 产品工作分支：`codex/v0.1-s05-overview-readonly`（自 S04 已验收分支提交 `b71bb50` 创建）
- 依赖检查：`npm ls --depth=0`
- 语法检查：`git ls-files '*.js' | xargs -n1 node --check`
- 自动化测试：`npm test`
- 健康检查：`PORT=43211 npm start` 后访问 `/api/health`
- 当前状态：S04 已完成用户功能验收并收口为 done；S05-A 只读总览已实现，等待用户页面验收。活动项目 Pi 面板已完成单节点挂载与切换同步，并修复窄视口下的容器溢出裁切；S04 交接状态一致性修复已完成；项目页/执行面板中英文对照已实现；群聊成员/模型维护、实验性 `~/.secrets.env` Key 管理、发送后清空输入已进入当前分支。记录的全量 `node --test` 为 279/279；逐文件语法检查、`git diff --check` 与 strict 结构校验通过。恢复与多任务并行仍为后续设计；本地 main 领先 `origin/main`，是否推送由用户决定。

## 当前切片

### S05 · 恢复与总览闭环（active，S05-A 已实现待页面验收，2026-08-26）

### 目标

让用户可以从总览看到当前任务、检查点、证据和唯一下一步，并在明确预览与确认后从安全检查点恢复任务；恢复失败时保留可追溯状态，不伪装为完成。

### 当前设计边界

- 先定义恢复点的数据契约、可恢复状态和恢复前预览，再决定页面入口与服务端状态迁移。
- 明确恢复动作是否只恢复任务状态，还是允许对项目文件做回退；任何文件回退都必须单独评估为高风险动作。
- 总览只汇总已有项目、执行、证据和交接事实，不复制或另建第二套事实源。
- 不在本阶段引入多任务并发、远程控制、自动 Git 提交/合并/推送或隐式破坏性回滚。

### Definition of Ready

- [x] S05-A 一句话目标、用户起点/终点和非目标已确认。
- [ ] 恢复点、预览、确认、失败和回退语义已形成设计决策（不属于 S05-A）。
- [x] 总览入口与现有项目/执行/证据模块的唯一所有权已明确。
- [x] S05-A 需求—证据映射、风险分级、保护路径和回滚策略已完成。
- [x] S05-A 测试策略覆盖正常、空闲、失败和敏感字段排除；未运行明确为 `not_run`。
- [x] 实现范围与工作分支策略已确认：`codex/v0.1-s05-overview-readonly`；多任务并行保持非目标。

### 唯一下一步

完成 S05-A 页面验收：打开总览，核对无项目/活动项目/空闲任务状态与项目页一致，确认任务证据和 AI 交接字段不泄露敏感内容，并确认离开总览后轮询停止。恢复与多任务并行不在本次实现内。

### S05-A · 只读任务总览（实现完成，待用户页面验收）

| 需求 | 实现与证据 | 当前结论 |
|---|---|---|
| 只读 AI 交接摘要 | `src/services/ai-handoff.js` 的 `readSummary`；`test/ai-handoff.test.js` 10/10 | 自动化 verified |
| 总览聚合接口 | `src/routes/overview.js`、`src/server.js`；`test/overview-routes.test.js` 7/7 | 自动化 verified |
| 中英文四卡片页面 | `public/index.html`、`public/js/index.js`、`public/js/overview.js`、`public/css/overview.css`；`test/overview-ui.test.js` 6/6 | 自动化 verified |
| 不暴露敏感任务/命令字段 | 路由字段白名单与总览敏感字段测试；不返回 task、output、stderr、args、cwd、完整路径列表 | 自动化 verified |
| 可见时轮询、离开停止 | 总览生命周期使用 5 秒轮询、AbortController 和请求序号；用户页面验收待完成 | 自动化 verified，用户待验收 |

S05-A 实现提交：`dc25964`（摘要读取）、`5e068d0`（聚合接口）、`4fc1037`（总览页面）。

### S04 · 证据与黑匣子（done，2026-08-26 用户功能验收通过）

### 目标

让下一次接手项目的 Codex/Pi 能读取严格的 AI 交接记录；产品本地黑匣子保存脱敏的任务事件，项目内保存当前交接和不可覆盖的历史记录。

### 验收标准

- [x] 任务开始/结束有 Git 前后快照，既有改动与运行窗口内变化分开记录。
- [x] Pi 的开始、输出、状态、结束、停止、失败和中断事件可追溯。
- [x] 用户确认的 argv-only 验收命令记录真实退出码；未运行明确标为 `not_run`。
- [x] `verified`、`user_confirmed`、`agent_reported`、`recorded_not_reverified`、`unknown` 严格分层。
- [x] `docs/ai-ops/NOW.md` 与 `docs/ai-ops/records/` 脱敏、原子写入、历史不可覆盖。
- [x] Key、Token、密码、私钥、环境变量和未脱敏 stderr 不进入项目文件、黑匣子或日志。
- [x] 失败、停止、中断和证据不足的任务仍有唯一下一步，不能伪装为完成。
- [x] 临时真实 Git 项目端到端验证已完成；S03、护航、群聊、终端和安装回归纳入 `npm test` 并通过。
- [x] 用户在本地页面完成一次端到端验收（2026-08-26 用户确认功能验收通过）。

### 明确不做

- 不做 Pi 会话续传、多任务并发、自动 Git 提交/合并/推送/回滚。
- 不保存完整原始终端日志，不从 Agent 自述推断测试通过，不自动猜测项目进度。
- 不改写护航、群聊、终端、安装主链路和现有 Node/Express/WebSocket/SSE/node-pty 技术栈。

### 允许修改范围

- 新增本地黑匣子、脱敏、任务证据、验收命令和 AI 交接服务及测试。
- 扩展 `src/server.js`、`src/routes/execution.js`、项目路由/边界、项目执行 UI 和对应测试。
- 更新 `.gitignore`、`docs/NOW.md`、`docs/PRODUCT.md`、`docs/CODEMAP.md`。
- 不碰 `.token`、真实 `.env`、`tools.json`、`projects.local.json.bak`、`public/vendor/`、群聊和护航主链路。

### Definition of Ready

- [x] 产品基线已接受，目标、范围、非目标和 high 风险已确认。
- [x] 设计稿已获用户审阅（`docs/superpowers/specs/2026-08-19-s04-ai-handoff-blackbox-design.md`）。
- [x] 实现计划已产出并提交（`docs/plans/2026-08-20-s04-ai-handoff-blackbox-implementation.md`）。
- [x] 目标项目写入需显式启用，验收命令需用户确认，产品不自动提交 Git。
- [x] 现有未跟踪备份已识别并保护：`projects.local.json.bak` 不读取、不暂存、不删除。
- [x] 唯一工作分支名称已确定：`codex/v0.1-s04-ai-handoff-blackbox`。
- [x] 测试、脱敏、恢复、失败路径、安全审查和真实验收策略已列入计划。

### 需求—证据映射

| 需求 | 实现与证据 | 当前结论 |
|---|---|---|
| 任务时间线与 Pi 生命周期 | `src/services/task-evidence.js`、`src/services/blackbox-store.js`；`test/task-evidence.test.js`、`test/s04-integration.test.js` | 自动化 verified |
| Git 前后快照与文件分类 | `src/services/task-evidence.js`、`src/services/git-inspector.js`；S04 临时 Git 项目含 pre-existing/new 变化 | 自动化 verified |
| argv-only 验收命令 | `src/services/validation-runner.js`、`src/routes/evidence.js`；shell=false、活动项目 cwd、审批、超时、输出上限 | 自动化 verified，用户功能验收通过 |
| 脱敏、原子当前交接、追加历史 | `src/services/safe-redactor.js`、`src/services/ai-handoff.js`；`docs/ai-ops/NOW.md` 与 `records/` | 自动化 verified |
| 失败、停止、中断和证据不足 | 统一 error code、`needs_review`、黑匣子恢复；未运行验证不可 accepted | 自动化 verified |
| 停止后可继续输入新任务 | `src/routes/execution.js` 在 `done` 后关闭 SSE；`public/js/execution.js` 收到终态立即释放 streaming；执行路由和 UI 回归测试 | 自动化 verified，用户功能验收通过 |

### 最近交接

- 最近一次候选实现：S04 evidence/blackbox/handoff 全链路已写入分支；用户于 2026-08-26 确认功能验收通过，切片已收口为 done。
- 2026-08-21：Pi 执行面板改为复用单一 DOM 节点，仅挂载在活动项目卡片下；切换活动项目后自动刷新执行边界；自动化测试增至 210/210。
- 2026-08-24：在隔离端口 `43211` 做只读页面检查：项目视图正常加载，活动项目数量 1，`#execution-panel` 数量 1，活动项目下的面板挂载数量 1；未点击启动、停止、AI 交接写入或验收命令。
- 2026-08-24 用户截图复核：`ACTIVE`、AI 交接记录和 Pi 工作边界的功能层级正确；但项目卡片仍显示 2026-08-13 的缓存分支/提交，需先点击“重新识别”，且 Pi 标题左侧存在裁切，视觉修复仍留在后续任务。
- 2026-08-24 用户刷新后截图：分支已更新为 `codex/v0.1-s04-ai-handoff-blackbox`、提交为 `ace9c93`，缓存问题已解除；Pi 标题仍贴近左边界并被裁切，功能验收可继续，视觉验收暂不通过。
- 2026-08-24：为 `#project-wrap` 增加 `width: 100%` 与 `box-sizing: border-box`，窄视口验证确认项目卡片、Pi 标题和执行卡片共享同一左边界；聚焦 UI 测试 23/23、全量测试 210/210。
- 2026-08-24：新的项目入口要求先读取 `docs/ai-ops/NOW.md`，但当前仓库未发现该文件；不能把项目状态中的“已启用”当作交接记录存在。用户需在项目页重新启用 AI 交接后，才能继续 S04 高风险验收。
- 2026-08-24 用户截图复核：独立项目“AI+ 知识学习项目”界面显示 ACTIVE、main 和 AI 交接已启用；只读核对其路径发现不是 Git 仓库，且 `docs/ai-ops/NOW.md` 与 `docs/ai-ops/records/` 均不存在。该项目状态属于缓存或路径不一致，不能启动 Pi。
- 2026-08-24 用户切换后的截图复核：另一个独立项目“个人资产管理”是有效 Git 仓库，`docs/ai-ops/NOW.md` 与 `docs/ai-ops/records/` 已存在；截图中的最近提交 `ed6c348` 仍是缓存值，实际只读核对的当前 HEAD 为 `6c0b7ae`。
- 2026-08-24 用户澄清：以上两个项目均不是当前 `pullic-talk` 项目；相关截图、目录检查和交接状态不构成 `pullic-talk` S04 验收证据，当前切片仍回到 `pullic-talk` 本身的交接文件与页面验收。
- 2026-08-24：定位并修复“交接状态已启用但文件不存在、页面因此没有启用按钮”的状态错位；交接服务现在检查 `AGENTS.md` 指针、`docs/ai-ops/NOW.md` 和 `records/` 的真实状态，页面在 `repair_required` 时显示“修复 AI 交接”，修复只补齐缺失受控文件并保留已有内容；实现提交 `1a29df7`、`4815688`、`de97f0a`、`12d5c6b`，设计与计划提交 `d5e355f`、`cabc883`。
- 2026-08-24：本次修复相关聚焦测试 60/60 通过；全量测试的 11 项失败来自既有未提交 members 改动（`AGENTS is not defined` 与临时服务监听权限），未发现本次交接修复回归。
- 2026-08-24 用户截图确认：当前 `pullic-talk` 页面显示 AI 交接“已启用且文件已就绪”，并展示 `docs/ai-ops/NOW.md` 与 `docs/ai-ops/records`；该项用户页面证据通过。截图中的最近提交仍为缓存值 `4671743`，需点击“重新识别”刷新后再作为当前 Git 事实使用。
- 2026-08-24 用户截图记录一次真实启动失败：任务在 Pi auth 检查阶段返回“Pi 认证未就绪”，时间线为 `failed`，Git after 为 `unknown`，验收为 `pending`；未进入 Pi 项目执行，也未产生可接受的产品证据。原因是服务当时未设置 `PI_AUTH_PROVIDER`，按默认 provider `google` 检查；随后已在隔离端口 43211 以 `PI_AUTH_PROVIDER=aliyun-token-plan` 重启服务，未读取或输出凭据。
- 2026-08-25：只读对账确认当前分支 HEAD 为 `a9ba9c9`，工作树干净；新增提交包含群聊成员/模型维护（`21b9759`）、实验性网页 Key 管理（`913384f`）、AI 交接入口（`0654777`）、项目页双语（`f066b9f`）、README 树刷新（`3c76dc5`）和发送后清空输入（`a9ba9c9`）。这些提交不是 S04 用户真实验收证据。
- 2026-08-25：文档对齐将 `~/.secrets.env` 明确标为实验性高风险路径：当前 API 会向已认证浏览器返回 Key 值，写入后同步当前服务进程，但应用重启不会自动解析该文件；README 中“新终端自动加载”的过度承诺已修正。S01 macOS Keychain 既有验收结论保持不变。
- 2026-08-26：全量 `node --test` 263/263 通过；工作树干净。`agents.config.json` 仅更新 pi 模型列表一项（`aliyun-token-plan/qwen3.8-max-preview` → `aliyun-token-plan/qwen3.8-max`，经网页成员面板修改后以最小 diff 提交 `046bdfd`）。本文件 `last_verified_commit` 同步为 `046bdfd`。
- 交接读取顺序：先读本文件，再读 `docs/PRODUCT.md`、`docs/CODEMAP.md`，最后读项目内 `docs/ai-ops/NOW.md` 与其 `latest_record`。

### S04 页面验收清单（历史操作记录）

> 2026-08-26 用户已确认 S04 功能验收通过；以下步骤保留为验收证据索引，不再作为当前切片阻塞。

环境准备：服务必须保持运行；访问 `http://localhost:43211`，若 localhost 解析异常改用 `http://127.0.0.1:43211`。只使用临时 Git 仓库，不把真实 Key、Token、密码或私钥放入任务文本。

- [x] 页面入口返回 200，项目页能加载，`/api/health` 返回 `ok: true`。
- [x] 在项目页录入一个临时 Git 仓库，确认分支、提交、改动计数和文件列表可见。
- [x] 点击“设为活动”，确认出现 `ACTIVE`，执行面板只出现在该项目卡片下，并显示正确工作边界；切换到另一个项目后，面板随之移动且旧项目下不重复出现。
- [x] 若页面显示“启用 AI 交接”或“修复 AI 交接”，点击对应显式操作，确认明确显示 `docs/ai-ops/NOW.md` 和 `docs/ai-ops/records`，且不会覆盖已有普通文档。
- [x] 在任务框输入无敏感信息的明确任务，点击“启动 Pi”后再确认一次；确认能看到流式输出和运行时长。
- [x] 任务结束后确认“任务时间线与验收”显示执行状态、Git before/after 和文件变化。
- [x] 在任务运行中点击“停止”，确认状态变为 stopped；重复启动确认 busy/单实例保护。
- [x] 在验收命令框填写程序和参数（例如 `npm` + `test`），先点“预览验收命令”，确认不会立即执行。
- [x] 再点“确认执行验收”，确认显示真实退出码、passed/failed、输出截断状态；不输入 shell 字符串。
- [x] 未运行或失败的验证不能标记 `accepted`；应能标记 `needs_review` 或 `rejected`。
- [x] 验证通过后点击“标记 accepted”，第二次确认后验收状态变为 accepted，重复关闭不覆盖历史记录。
- [x] 在临时仓库检查 `docs/ai-ops/NOW.md` 与 `docs/ai-ops/records/<taskId>.md`，确认存在唯一下一步和历史记录。
- [x] 修改前已有的文件改动仍存在，且被记录为 pre-existing；Pi 新建/修改文件单独列出。
- [x] 用假敏感字符串做安全检查（如 `API_KEY=example`），确认它不会出现在交接、黑匣子、Git 状态或日志中；不要使用真实凭据。
- [x] 刷新页面或重启服务后，已结束任务仍可读；中断中的任务应显示 interrupted，不产生孤儿进程。
- [x] 记录结果：`accepted`；用户于 2026-08-26 确认 S04 功能验收通过。

### S02b · 多项目并行管理（done，2026-08-12 用户验收通过）

### 目标

在项目 view 同时录入多个 Git 项目，以列表查看各自状态（分支、改动、失效），可逐项刷新、移除，并指定一个活动项目供 S03 的 Pi 受控运行使用。

### 验收标准

- [x] 可录入多个 Git 项目，同仓库重复录入幂等（不产生重复条目）。
- [x] 列表展示每个项目的分支、最近提交、改动计数与失效状态；失效项可区分。
- [x] 可逐项刷新与移除（移除需就地确认）；移除活动项目后活动标记置空。
- [x] 可指定/切换活动项目；活动项目在 UI 有明确标记，状态接口暴露 `activeProjectId`。
- [x] v1 单项目状态文件（`projects.local.json`）自动迁移到 v2 多项目结构，不丢失已有项目。
- [x] 识别仍只读零写入；全量 `npm test` 通过，既有护航/群聊/终端不受影响。

### 明确不做

- 不做项目分组、排序偏好、批量操作或多用户协作。
- 不改变 S03 的 Pi 执行语义（仍单实例、单项目内执行）。
- 不改 git-inspector 的只读识别逻辑；不改护航、群聊、终端、安装链路。

### 允许修改范围

- `src/services/project-boundary.js`（数据模型 v2 + 活动项目）
- `src/routes/project.js`（契约扩展：`activate`；`refresh/clear` 按 id）
- `public/js/project.js`、`public/css/project.css`（列表 UI）
- 对应测试 `project-boundary.test.js`、`project-routes.test.js`、`project-ui.test.js`（含迁移测试）
- `docs/PRODUCT.md`、`docs/NOW.md`、本设计稿
- 不修改 `src/server.js` 装配以外的必要一行（若需要）；不碰护航/群聊/终端/安装/`public/vendor/`。

### Definition of Ready

- [x] 目标可用一句话讲清楚
- [x] 起点和终点可观察
- [x] 验收标准可执行到产品行为层
- [x] 非目标明确
- [x] 修改范围精确到文件或目录
- [x] 代码入口和验证命令明确（`npm test`、隔离端口健康检查、迁移夹具）
- [x] 基线状态已记录（main 当前 HEAD `e01ba95`，工作区干净）
- [x] 唯一工作分支名称已确定（`codex/v0.1-s02b-multi-project`，自 `main` 当前 HEAD）
- [x] 未知改动已识别并有保护方案（护航折叠 4 文件已于 `44eee58` 提交，工作区干净）
- [x] 设计稿获用户批准（2026-08-12，`accepted`）
- [x] 实现计划已产出（[S02b 实现计划](plans/2026-08-12-s02b-multi-project-implementation.md)，6 任务 TDD）

## 需求—证据映射（S02b）

| 需求 | 自动证据 | 真实/人工证据 | 当前状态 |
|---|---|---|---|
| 多项目录入幂等 | 服务多项目增删/幂等测试通过（`671e2ef` 起 22 项） | 用户录入多个真实项目并核对列表，重复录入不产生重复条目 | 自动与真实验收通过 |
| 逐项刷新/移除 + 活动项目 | 路由契约 14 项 + 活动切换测试通过 | 用户切换活动项目并核对 ACTIVE 徽标；逐项刷新/移除（双击确认）；移除活动项目后活动置空 | 自动与真实验收通过 |
| v1→v2 迁移不丢数据 | 迁移夹具测试通过（真实 v1 格式含 selectionSnapshot/lastInspection） | 用户确认原「个人资产管理」项目迁移后仍在且自动标记活动；磁盘文件已为 v2 结构 | 自动与真实验收通过 |
| 只读识别不回归 | 全量 `npm test` 127/127 + 禁改路径 diff 审计通过 | 验收前后本仓库与「个人资产管理」的 `git status --porcelain` 与 `git stash list` 完全一致 | 自动与真实验收通过 |

### S03 · Pi 受控运行（done，2026-08-13 用户验收通过）

### 目标

用户在项目 view 选定活动项目后，输入任务提示词并确认风险，Pi 在该项目目录内受控执行；流式输出可见，可随时停止，不越界。

### 验收标准

- [x] 活动项目已设置且非失效时，可输入任务并启动 Pi。
- [x] Pi 的 cwd 严格为活动项目的 repoRoot；不传 `--api-key`。
- [x] 启动前检查 `pi auth check --provider <P> --json` 就绪（P：`PI_AUTH_PROVIDER` > `PI_PROVIDER` > `google`，D7）；未就绪给出明确指引。
- [x] 输出流式可见，状态灯准确（idle/running/stopped/exited/error）。
- [x] 停止按钮发 SIGTERM 终止当前运行；服务关闭时清理进程无孤儿。
- [x] 同时只允许 1 个 Pi 运行；运行中拒绝新启动（busy）。
- [x] UI 启动前显示风险确认；动态内容仅用 textContent。
- [x] 不修改 agent-caller、群聊、终端、安装、护航与 S02 项目边界代码。

### 明确不做

- 不做真正的暂停/恢复（Pi `-p` 单次执行）；不做会话续传。
- 不做沙箱隔离（Pi 拥有完整用户权限）。
- 不传 DeepSeek Key 或任何密钥给 Pi；Pi 认证独立。
- 不做多任务并发、费用控制或输出结构化解析。

### 允许修改范围

- 严格限定在 [S03 设计稿 §9](plans/2026-08-06-s03-pi-controlled-run-design.md#9-精确修改范围)：7 个新增文件 + `src/server.js`、`public/index.html`、`public/js/project.js`。
- 不修改 `src/agent-caller.js`、`src/routes/api.js`、`public/js/chat.js`、`public/vendor/`、`tools.json`、`.token`、`agents.config.json`、终端/安装/启动与 S01/S02 全部文件。

### Definition of Ready

- [x] 目标可用一句话讲清楚
- [x] 起点和终点可观察
- [x] 验收标准可执行到产品行为层
- [x] 非目标明确
- [x] 修改范围精确到文件或目录
- [x] 代码入口和验证命令明确
- [x] 基线状态已记录（main HEAD `0a2b44e`，S02b 合并后）
- [x] 唯一工作分支名称已确定（`codex/v0.1-s03-pi-controlled-run`，自 `main` HEAD `0a2b44e`）
- [x] 未知改动已识别并有保护方案（另一会话产出的 S03 两份文档已随 D7–D9 修订一并提交）
- [x] 关键决策已确认（D1–D6，2026-08-06 用户确认；D7–D9，2026-08-12 用户确认）
- [x] 设计稿获用户批准（2026-08-06 批准；2026-08-12 修订后再次确认）
- [x] 实现计划已产出（[S03 实现计划](plans/2026-08-06-s03-pi-controlled-run-implementation.md)，已含 D7–D9 修订）

S01、S02 均已合并入 `main`（基线 `be2b595`）；其需求—证据映射保留在下方存档段落。

## 需求—证据映射

（当前切片：S03）

| 需求 | 自动证据 | 真实/人工证据 | 当前状态 |
|---|---|---|---|
| Pi 只在活动项目内启动（D8） | PiExecutor cwd=活动项目 repoRoot 断言 + 假 pi 夹具测试（`ebb2453` 16 项） | 用户在 `/tmp/s03-acceptance` 真实运行，cwd 正确；验收前后 `find` 对比完全一致，Pi 零写入 | 自动与真实验收通过 |
| 启动前 auth 就绪检查（D7） | `pi auth check --provider <P> --json` 就绪/失败/ENOENT/provider 解析链测试 | 用户以 `PI_AUTH_PROVIDER=aliyun-token-plan` 启动服务，真实认证检查通过后运行 | 自动与真实验收通过 |
| 输出流式可见 | SSE chunk 事件回放/直播 + 输出截断测试；D10 改 `--mode json` NDJSON 解析（text 模式实测无法流式） | 用户观察文字逐段流出（thinking 期几秒安静属预期） | 自动与真实验收通过 |
| 可停止（SIGTERM） | 停止生命周期（exit 事件收尾）+ 超时回收测试；真实 pi SIGTERM 0 秒退出实测 | 用户运行中点停止，状态灯变 STOPPED，`pgrep` 无残留 | 自动与真实验收通过 |
| 单运行实例 | busy 拒绝测试 | 用户验证运行中二次启动被拒 | 自动与真实验收通过 |
| 风险告知 + UI 安全 | UI 静态回归断言无 innerHTML/EventSource、含 riskConfirmed、仅 4 个端点；运行面板不挤压项目列表（`f045073`） | 用户双击确认后才启动；布局反馈修复后复验通过 | 自动与真实验收通过 |

## 需求—证据映射（S02 存档记录）

| 需求 | 自动证据 | 真实/人工证据 | 当前状态 |
|---|---|---|---|
| 可选择真实 Git 项目并准确识别 | Git Inspector 19 项、Boundary 11 项、Routes 9 项、UI 8 项测试通过;临时仓库夹具覆盖干净/脏/冲突/detached/unborn/远端 | 用户选择本仓库与干净仓库,识别结果与 `git status` 事实核对 | 自动与真实验收通过 |
| 错误可区分（非仓库/不存在/文件/禁止根） | 路径安全与错误映射测试覆盖全部稳定错误码 | 用户输入非 Git 目录（声音世界）、不存在路径验证错误卡 | 自动与真实验收通过 |
| 持久化与失效检测 | 重启加载、损坏文件降级、失效检测、幂等清空测试通过 | 用户完成选择与移除；持久化跨重启由自动化测试覆盖 | 自动与真实验收通过 |
| 识别只读，零写入 | 命令白名单只读断言 + 测试夹具仅用临时目录 | 验收仓库前后 `git status --porcelain` 与 `git stash list` 完全一致 | 自动与真实验收通过 |
| 移除需就地确认，UI 无 HTML 注入 | UI 静态回归断言无 innerHTML/localStorage、含确认态 | 用户完成一次移除双击确认 | 自动与真实验收通过 |
| 既有链路不受影响 | 全量 `npm test` 109/109；禁改路径 diff 审计通过 | 用户验证护航、群聊、控制台等旧功能 | 自动与真实验收通过 |

## 需求—证据映射（S01 存档记录）

| 需求 | 自动证据 | 真实/人工证据 | 当前状态 |
|---|---|---|---|
| Key 可录入、替换、删除且只显示脱敏状态 | Credential Store 与路由测试通过；API 状态响应使用字段白名单 | 用户在网页完成保存、替换、删除，并在 Keychain Access 核对固定条目 | 自动与真实验收通过 |
| S01 Keychain 路径的 Key 不进入仓库、普通配置、日志或进程参数 | 测试断言假 Key 只经受控 PTY 传入且不在 argv/环境/输出/错误/响应；S01 源码无浏览器持久化；差异检查通过 | 用户确认验收全过程未在聊天、终端、Git 状态、普通配置或日志中暴露 Key | 自动与真实验收通过 |
| 错误可区分 | Provider 与路由测试覆盖 401、402、429、400/422、5xx、超时、网络和非法响应，且 DeepSeek 401 不冒充本地认证失败 | 用户以无效 Key 验证凭据错误 | 自动与真实验收通过 |
| 护航 AI 有真实回复与可靠状态 | Escort Service 状态机、并发与安全错误测试通过 | 用户使用真实 DeepSeek Key 完成一次对话 | 自动与真实验收通过 |
| Pi 不可用不影响护航 | 新控制面不导入 CLI/Agent 调用器；路由、服务和 UI 独立装配 | 用户确认 Pi 不可用时仍可完成护航对话 | 自动与真实验收通过 |
| 验收可重复 | `npm test` 62/62；macOS 无写入 PTY 探针 12/12；新文件语法、差异、隔离端口健康、桌面/窄屏布局与严格状态校验通过 | 用户按设计稿 §12.2 完成真实验收 | 通过 |

## 验证证据

- 2026-08-04：`npm ls --depth=0` 通过，Express、node-pty、ws 依赖完整。
- 2026-08-04：28 个已跟踪 JavaScript 文件通过 `node --check`。
- 2026-08-04：服务在临时端口 `43210` 启动成功；`/api/health` 返回 `ok: true`、7 个可用 Agent、0 个活动子进程；检查后已正常关闭。
- 2026-08-04：默认端口 `3210` 已被其他进程占用；未结束或修改该进程。
- 2026-08-05：产品大纲、八模块唯一所有权和 `v0.1-first-controlled-mission` 已写入事实源；尚未执行任何产品代码验证。
- 2026-08-06：Solo Dev Loop V4 结构校验在迁移前通过；确认旧文档仍按 V3 识别，随后开始 V4 迁移与 S01 设计。
- 2026-08-06：本机 `/usr/bin/security` 帮助确认通用密码可增改、读取、删除，并明确 `-w` 置于末尾时通过提示输入，避免把秘密放入命令参数；尚未写入任何真实钥匙串条目。
- 2026-08-06：Keychain 首次真实网页保存失败；服务日志只出现固定密码提示，没有 Key。根因是 Apple `security -w` 从控制终端而非普通 stdin 读取；修复提交 `dffb804` 改用既有 `node-pty` 的受控提示输入。
- 2026-08-06：`npm test` 共 60 项全部通过：Credential Store 11、DeepSeek Provider 13、Escort Service 14、Escort Routes 22；额外 macOS 无写入 PTY 探针 12/12 通过，并确认终止提示不会生成测试条目。
- 2026-08-06：S01 的 Provider、Credential Store、Escort Service、Escort Routes、服务装配和前端脚本均通过 `node --check`；基线至 `dffb804` 的 `git diff --check` 通过。
- 2026-08-06：完整差异审计确认旧 CLI 群聊、终端、安装链路、`package-lock.json`、`public/vendor/`、`.token`、`tools.json` 与 `agents.config.json` 未改变；状态 API 额外增加字段白名单回归测试。
- 2026-08-06：服务在隔离端口 `43211` 启动，`/api/health` 返回 `ok: true`、7 个可用 Agent、0 个活动子进程；首页包含护航面板，检查后只关闭本次启动的服务。
- 2026-08-06：受控浏览器在 1280×720 验证 392px 右侧护航栏不覆盖原视图；在 760×720 验证全宽覆盖层开关、滚动与无横向溢出；两种布局均无控制台错误或警告，密码输入为空且类型为 `password`。
- 2026-08-06：以上验证没有输入、读取或提交真实 Key，没有增改删任何真实 Keychain 条目，也没有向 DeepSeek 发起真实计费请求；真实外部链路仍未验收。
- 2026-08-06：当前 HEAD `7ff8b5e` 的 `npm test` 62/62 通过；新增 UI 回归覆盖“仅在 Keychain 保存成功后清空输入”，并覆盖受控 PTY 的 Keychain 二次确认提示。未运行会创建临时 Keychain 条目的写入探针，真实外部链路仍未验收。
- 2026-08-06：用户完成 S01 真实验收并确认无问题：Keychain 保存、替换、删除及固定条目核对通过；DeepSeek 连接与真实护航回复通过；无效 Key 的凭据错误可识别；Pi 不可用时护航仍可用；用户确认 Key 未出现在聊天、终端、Git 状态、普通配置或日志。用户未向 AI 提供 Key。
- 2026-08-06：在候选提交 `7ff8b5e` 上复跑 `npm test`，62/62 通过；`validate-project-state.mjs . --strict` 通过。
- 2026-08-06：S01 收尾完成：`codex/v0.1-s01-escort-online` 以 fast-forward 合并入 `main`（新基线 `cf62d8f`），工作分支已删除；`npm test` 62/62 与 `--strict` 校验均在合并后的 HEAD 复跑通过；用户未提交改动仅剩 `.gitignore` 的 `.superpowers/` 规则，保持原样。
- 2026-08-06：查明“功能时好时坏”根因：默认端口 3210 被 2026-07-31 启动的旧实例（早于 S01 的代码）占用，用户访问 3210 时命中的是旧代码。经用户授权结束该实例（PID 25068），并在 3210 启动 S01 合并后的服务，`/api/health` 返回 `ok: true`。用户随后在 `http://localhost:3210/` 复测护航功能。
- 2026-08-06：用户在 3210 端口的合并后服务上复测护航 AI，确认功能通过（连接检测、真实回复与身份设定均符合预期）；这是 S01 合并入 main 后的新鲜行为证据。
- 2026-08-06（S02）：全量 `npm test` 109/109 通过（既有 62 + Git Inspector 19 + Boundary 11 + Routes 9 + UI 8）；全部测试夹具只在系统临时目录创建仓库，未触碰任何真实仓库。
- 2026-08-06（S02）：全部已跟踪 JS 文件 `node --check` 通过；`git diff --check` 自基线干净；隔离端口 43212 健康检查 `ok: true`，无 Token 访问 `/api/project/status` 返回 401；验证实例随后关闭。
- 2026-08-06（S02）：禁改路径审计通过：`git diff --name-only main...HEAD` 仅含 9 个新增文件、`src/server.js`、`public/index.html`、`public/js/index.js` 与 `docs/`；护航、群聊、终端、安装、`public/vendor/` 等全部未触碰。真实验收（三场景 + 零写入证明）待用户在分支代码上完成。
- 2026-08-06（S02）：用户在 `http://localhost:3210/` 完成真实验收：选择本仓库识别出 `.gitignore` 的未暂存改动、分支 `main` 与最近提交；干净仓库计数全 0；非 Git 目录（声音世界）返回 `not_a_git_repo` 错误卡；不存在路径与文件路径均返回可区分错误；移除项目双击确认后清空。零写入证明通过：验收前后 `git status --porcelain` 与 `git stash list` 完全一致。
- 2026-08-12（S02b）：用户在分支代码（3210 端口）完成真实验收：迁移后「个人资产管理」保留且自动标记活动；录入多个真实项目并验证重复录入幂等；切换 ACTIVE 徽标跟随；逐项刷新/移除（双击确认）与移除活动项目后置空均正常；护航、群聊、终端冒烟通过。零写入证明通过：验收前后本仓库与「个人资产管理」的 `git status --porcelain` / `git stash list` 完全一致；磁盘 `projects.local.json` 已核对为 v2 结构且 selectionSnapshot/lastInspection 完整。用户反馈列表不可滚动与用途文案不清，已在 `cbc4d18` 修复（`#project-wrap` 滚动 + 用途说明），修复后用户复验确认无问题；`npm test` 127/127 复跑通过。
- 2026-08-12（S03）：Task 1–4 自动验证在候选提交 `1423922` 通过：`npm test` 160/160（既有 127 + PiExecutor 16 + 执行路由 10 + 运行面板 UI 7）；PiExecutor 全部用 tmpdir 假 pi 夹具，argv 断言仅 `-p <task> --no-session` 且永不含 `--api-key`，auth 检查断言 `auth check --provider <P> --json` 与 provider 解析链；全部已跟踪 JS `node --check` 通过；`git diff --check` 干净；diff 仅含计划内 9 个文件（agent-caller/群聊/终端/安装/护航/S02 文件均未触碰）；隔离端口 43213 `/api/health` 返回 `ok: true`，无 Token 访问 execution status/start 均 401。未发起任何真实 Pi 调用与计费请求；真实验收待用户完成。
- 2026-08-13（S03）：用户真实验收发现并修复三处问题，均在分支内修复后复验通过：① 运行面板误读不存在的 `payload.active` 字段导致始终显示「尚未设置活动项目」（`b037817`，改为从 `projects` + `activeProjectId` 推导）；② pi 文本模式将输出全部缓存至结束才吐出，无法流式（D10，`1c5c906`，改 `--mode json` NDJSON 解析，仅 assistant text_delta 进流，thinking 不外泄）；③ 运行面板挤压项目列表空间（`f045073`，项目视图改为整体滚动流）。修复后全量 161/161 通过。
- 2026-08-13（S03）：用户在 3210（`PI_AUTH_PROVIDER=aliyun-token-plan` 启动）完成真实验收：风险双击确认门禁生效；真实 Pi（aliyun-token-plan / qwen3.8-max）在 `/tmp/s03-acceptance` 内流式执行多个任务，cwd 正确；运行中停止生效、状态灯变 STOPPED；运行中二次启动被 busy 拒绝；无活动项目时面板正确拦截。不越界证明通过：验收前后 `find /tmp/s03-acceptance -type f` 完全一致、测试仓库 `git status --porcelain` 与 `stash list` 为空、`pgrep -f "pi -p"` 无残留。
- 2026-08-14（热修复）：用户测试时首页打不开，根因为旧代码 `watchHtml` 在文件写入半途的 watch 事件读到空文件并缓存，导致 `/` 永久返回 0 字节（既有缺陷，非 S03 引入）。修复 `c31ba80`：50ms 防抖 + 空读保留旧缓存；实测截空 index.html 时服务仍返回旧缓存、恢复后热加载正常；`npm test` 161/161 复跑通过。

## 阻塞

- 当前没有实现阻塞。
- S04 尚未完成目标、边界、风险分级和验收证据映射；在 Definition of Ready 前不修改产品代码。

## 唯一下一步

进入 S04「证据与黑匣子」设计：先定义任务时间线、文件变化、命令/测试证据和脱敏记录的最小可观察闭环，再确定持久化边界与验收方式。

## 最近交接

### 2026-08-13 · S03 真实验收通过，待合并

- 当前阶段：`build -> release`；切片：`S03-pi-controlled-run (done)`；工作分支：`codex/v0.1-s03-pi-controlled-run`，待合并。
- 已完成：用户真实验收全部通过（风险门禁、流式、停止、busy、不越界、无孤儿）；验收中发现的三处问题（活动项目推导、流式模式、布局挤压）均已在分支修复并复验；161/161 测试在候选提交通过。
- 未完成：合并回 `main`、更新基线；S04 设计。
- 恢复动作：先读本文件；按 S01/S02/S02b 仪式 fast-forward 合并并删除工作分支；合并后运行中的 3210 服务仍是分支代码（与 main 合并后内容一致），无需立即重启。

### 2026-08-12 · S03 Task 1–4 自动验证完成，等待真实验收

- 当前阶段：`build`；切片：`S03-pi-controlled-run (active)`；工作分支：`codex/v0.1-s03-pi-controlled-run`（候选提交 `1423922`，3 个实现提交）。
- 已完成：Task 1–4（PiExecutor、SSE 路由与装配、运行面板）；`npm test` 160/160；`node --check`、`git diff --check`、隔离端口 43213 健康与 401 闸门、禁改路径审计全部通过。实现中修正：子进程收尾用 `exit` 事件（孙进程持有管道时 `close` 延迟）；测试慢 pi 用 `exec sleep` 避免孤儿。
- 未完成：Task 5 用户真实验收（风险确认、流式输出、停止、busy、不越界）。
- 恢复动作：先读本文件；以 `PI_AUTH_PROVIDER=aliyun-token-plan PORT=3210 npm start` 启动分支代码，引导用户按计划 Task 5 完成验收并回写证据；验收未过不标 `done`。

### 2026-08-12 · S03 Ready，进入实现

- 当前阶段：`build`；切片：`S03-pi-controlled-run (active)`；工作分支：`codex/v0.1-s03-pi-controlled-run`（自 main HEAD `0a2b44e` 创建）；风险：high。
- 已完成：S02b 合并（基线 `b371ba4`→记录提交 `0a2b44e`）；前端优化插播任务经审计后由用户取消（零改动）；S03 两份文档审读，发现并修正三处冲突（D7 auth 命令需带 provider；D8 边界改为活动项目；D9 基线/测试数更新），用户确认；DoR 全部满足。
- Pi CLI 实测：v0.84.1；`-p`/`--no-session` 存在；`pi auth check` 必须带 `--provider`/`--model`；本机 provider `aliyun-token-plan` ready，默认 `google` not_ready。
- 未完成：Task 1–5 全部实现与验收。
- 恢复动作：先读本文件；按计划从 Task 1（PiExecutor + 假 pi 夹具，测试先行）开工；范围变化先回设计稿。

### 2026-08-12 · S02b 真实验收通过，待合并

- 当前阶段：`build -> review`；切片：`S02b-multi-project (done)`；工作分支：`codex/v0.1-s02b-multi-project`，待合并。
- 已完成：用户真实验收六项全部通过；零写入证明通过；滚动与用途文案两项反馈修复（`cbc4d18`）后复验通过；127/127 测试在候选提交复跑通过。
- 未完成：合并回 `main`、更新基线；S03 开工准备。
- 恢复动作：先读本文件；按 S01/S02 仪式 fast-forward 合并并删除工作分支。

### 2026-08-12 · S02b 自动验证完成，等待真实验收

- 当前阶段：`build`；切片：`S02b-multi-project (active)`；工作分支：`codex/v0.1-s02b-multi-project`（候选提交 `c2c15a6`，4 个实现提交）。
- 已完成：Task 1–5（v2 数据模型与 v1 迁移、活动项目与按 id 刷新/移除、路由契约扩展、列表 UI）；`npm test` 127/127；`node --check` 与 `git diff --check` 通过；禁改路径审计通过（diff 仅含允许范围文件）；隔离端口 43215 健康检查 `ok: true`，无 Token/错 Token 均 401；真实 `projects.local.json` 未受影响（仍 v1），已备份为 `projects.local.json.bak`（不提交）。
- 未完成：Task 6 用户真实验收（迁移核对、多项目录入、活动切换、零写入证明、旧链路冒烟）。
- 恢复动作：先读本文件；用分支代码重启服务，引导用户按计划 Task 6 完成验收并回写证据；验收未过不标 `done`。

### 2026-08-12 · S02b Ready，进入实现

- 当前阶段：`build`；切片：`S02b-multi-project (active)`；工作分支：`codex/v0.1-s02b-multi-project`（自 main 当前 HEAD 创建）。
- 已完成：护航折叠改动提交（`44eee58`，`npm test` 110/110 通过）；S02b 设计稿获用户批准（`accepted`）；DoR 全部勾齐；6 任务 TDD 实现计划产出。
- 未完成：Task 1–6 全部实现与验收。
- 恢复动作：先读本文件；按计划从 Task 1（v2 数据模型 + v1→v2 迁移，测试先行）开工；范围变化先回设计稿。

### 2026-08-06 · S03 设计稿产出

- 当前阶段：`design`；切片：`S03-pi-controlled-run (candidate)`；基线：`be2b595`（main）；待建分支：`codex/v0.1-s03-pi-controlled-run`。
- 已完成：S02 合并入 main 并推送 origin；Pi CLI 调查（v0.84.1）；D1–D6 用户确认；[S03 设计稿](plans/2026-08-06-s03-pi-controlled-run-design.md)产出（`draft`）。
- 未完成：用户批准设计稿、实现计划、工作分支创建与全部实现/验收。
- 恢复动作：先读本文件；若用户已批准设计稿，更新 `status: accepted` 并勾选 DoR，随后产出实现计划。

### 2026-08-06 · S02 完成

- 当前阶段：`design`；切片：`S02-git-safety-boundary (done)`；工作分支：`codex/v0.1-s02-git-safety-boundary`，待合并。
- 已完成：Git Inspector、Boundary Service、路由装配、项目 view、全量自动验证（109/109）与用户真实验收（三场景 + 零写入证明通过）。
- 已确认边界：护航、群聊、终端、安装链路未改；识别全程只读；`.gitignore` 两行已一并提交。
- 未完成：合并回 `main`；S03 设计。
- 恢复动作：先读本文件；合并 S02 后围绕 S03「Pi 受控运行」做设计。若要改动 S02，只限于已发现缺陷并补回归测试。

### 2026-08-06 · S02 真实验收通过

- 当前阶段：`build -> review`；切片：`S02-git-safety-boundary (active，待标 done)`；工作分支：`codex/v0.1-s02-git-safety-boundary`。
- 已完成：用户在分支代码上完成全部验收场景；零写入证明通过；109 项自动化测试在候选提交上通过。
- 未完成：`.gitignore` 两行暂存决定；标记 `done` 并合并回 `main`。
- 恢复动作：先读本文件；确认 `.gitignore` 暂存策略后标记 `done`，再按 S01 仪式合并回 `main`。

### 2026-08-06 · S02 实现完成，等待真实验收

- 当前阶段：`build`；切片：`S02-git-safety-boundary (active)`；工作分支：`codex/v0.1-s02-git-safety-boundary`（自基线 `40c5e48`，已含 5 个实现提交）。
- 已完成：Task 1–5（Git Inspector、Boundary Service、路由装配、项目 view、全量自动验证）；`npm test` 109/109；隔离端口健康与 401 闸门验证通过；禁改路径审计通过。
- 未完成：Task 6 用户真实验收（三场景 + 零写入证明 + 重启/失效/移除）；`.gitignore` 两行的暂存决定；验收通过后合并 main。
- 恢复动作：先读本文件；用分支代码重启 3210 服务，引导用户按实现计划 Task 6 完成验收并回写证据；验收未过不标 `done`。

### 2026-08-06 · S02 设计稿产出

- 已完成：D1–D6 用户确认；S02 设计稿产出并获批准（`accepted`）。

### 2026-08-06 · S01 合并入 main

- 当前阶段：`design`；切片：`S01-escort-online (done)`；稳定基线：`cf62d8f`；无产品工作分支。
- 已完成：S01 全部交付物以 fast-forward 合并入 `main`，工作分支删除；事实源基线记录已更新。
- 未完成：S02 设计与实现；`origin/main` 推送与否待用户决定。
- 恢复动作：先读本文件；确认 S02 设计决策（D1–D6）后写设计稿，Ready 后从 `cf62d8f` 创建工作分支。

### 2026-08-06 · S01 完成

- 已完成：独立 DeepSeek Provider、修订后的 macOS Keychain PTY 适配器、护航状态机、认证路由、常驻/响应式护航面板，以及 62 项默认测试、macOS 无写入探针、本地页面验证与用户真实验收。
- 已确认边界：旧 CLI 群聊与终端链路未改；护航不调用工具；秘密不写普通文件或浏览器持久化；`.gitignore` 用户改动未暂存。
- 若要改动 S01，只限于已发现缺陷并补回归测试。

## 会话记录

### 2026-08-14 · 项目列表专注折叠（用户直接要求的 UI 插播）

- 完成：`d219586`（经 `codex/v0.1-project-fold-focus` 分支 fast-forward 合并）：存在活动项目时，其他项目卡片折叠为单行（目录名 + 失效徽标 + 分支/改动概要），点「▸ 展开」可临时展开，展开卡片有「▾ 收起」；活动项目切换/清空时重置手动展开态；折叠态仅会话内存，无浏览器持久化。
- 验证：`npm test` 163/163（基线 162 含 c56b5b3 新增的 1 项；本次新增 1 项折叠回归测试并在样式测试中补充 2 项断言）；`node --check` 通过；3210 运行中服务已直接返回新 JS/CSS（express.static 读盘），用户刷新页面即可验收。
- 验收：2026-08-18 用户确认真实折叠体验正常；该插播任务收口，后续进入 S04 设计。

### 2026-08-14 · 首页空白热修复

- 完成：定位并修复 `watchHtml` 空读缓存缺陷（`c31ba80`，防抖 + 空读保护），服务已重启恢复访问；161/161 复跑通过。
- 发现：该缺陷为既有代码问题（S01 前就存在），被桌面文件同步/编辑器类写入在 watch 事件窗口内触发；S03 功能未受影响。
- 下一步：用户继续 S03 自由测试；之后进入 S04 设计。

### 2026-08-13 · S03 真实验收通过与修复

- 完成：用户真实验收 S03（风险门禁、流式输出、停止、busy 拒绝、不越界、无孤儿进程）；验收中发现并修复三处：活动项目推导（`b037817`）、`--mode json` 流式（D10，`1c5c906`）、运行面板布局挤压（`f045073`）；161/161 复跑通过；证据回写。
- 决定：pi 调用契约为 `-p <task> --no-session --mode json`（D10 记入设计稿）；运行面板与项目列表改为整体滚动流，不互相挤压。
- 下一步：合并回 main；S04 设计。

### 2026-08-12 · S02b 合并与 S03 开工

- 完成：S02b 真实验收通过并 fast-forward 合并入 main（`b371ba4`，记录提交 `0a2b44e`），工作分支删除；前端优化插播任务完成审计（字体被 CSP 拦截、窄屏溢出、小点击目标、favicon 404）后由用户取消，零改动；S03 设计稿与实现计划审读，D7–D9 修订获用户确认。
- 决定：auth 检查用 `pi auth check --provider <P> --json`（P：`PI_AUTH_PROVIDER` > `PI_PROVIDER` > `google`）；Pi cwd 取活动项目 repoRoot；验收以 `PI_AUTH_PROVIDER=aliyun-token-plan` 启动服务；不推送 origin（用户决定）。
- 下一步：建分支，从 Task 1 开工。

### 2026-08-12 · S02b Task 1–5 实现与自动验证

- 完成：v2 数据模型与 v1 迁移、活动项目（setActive）、按 id 刷新/移除、路由契约（activate + project_not_found 404）、列表 UI（ACTIVE 徽标、按卡片确认）；127/127 测试、语法/差异/隔离端口健康与 401 闸门、禁改路径审计全部通过。
- 决定：Task 1+2 服务层合并为一个提交；状态文件不再随 clear 删除，空状态为 v2 空 `projects`；真实 `projects.local.json` 验收前备份为 `.bak`。
- 注意：会话期间发现另一会话修改了 S03 设计稿（标记 accepted）并新增 S03 实现计划文件，均为用户资产，保持未暂存不动。
- 下一步：Task 6 用户真实验收。

### 2026-08-12 · S02b 批准与 Ready

- 完成：用户批准 S02b 设计稿；护航折叠 4 文件提交至 main（`44eee58`，110/110）；实现计划产出；DoR 补齐。
- 决定：`project_not_found` 映射 HTTP 404；`clear` 不再删除状态文件，空状态为 v2 空 `projects`；卡片移除沿用双击确认、按卡片独立确认态。
- 下一步：建分支 `codex/v0.1-s02b-multi-project`，从 Task 1 开工。

### 2026-08-06 · S03 设计启动

- 完成：S01+S02 合并后推送 origin/main；Pi CLI 调查（v0.84.1）；D1–D6 设计决策获用户确认；S03 设计稿（draft）产出并链接入 NOW。
- 决定：S03 采用独立 PiExecutor + SSE 路由 + 项目 view 运行面板；Pi 认证独立、不传密钥；暂停=停止；风险 high。
- 下一步：用户批准设计稿 -> DoR 补齐 -> 实现计划 -> 建分支开工。

### 2026-08-06 · S02 完成与合并准备

- 完成：S02 全部 6 个任务实现与验收；109 项自动化测试在候选提交 `8b73080` 上通过；用户真实验收通过（三场景 + 零写入证明）；`.gitignore` 两行一并提交。
- 决定：S02 标记 `done`，待合并回 `main`。
- 下一步：fast-forward 合并，更新基线；进入 S03 设计。

### 2026-08-06 · S02 设计与计划完成，Ready

- 完成：S02 设计稿获用户批准（accepted）；DoR 全部满足；产出 6 任务 TDD 实现计划；S01 需求—证据映射转为存档段落。
- 决定：错误响应沿用护航形状 `{ ok:false, code, message, action, retryable }`；`switchView` 一行改动补录入设计稿 §10.2；`.gitignore` 暂存策略实现时征求用户同意。
- 下一步：建分支 `codex/v0.1-s02-git-safety-boundary`，从 Task 1（Git Inspector）开工。

### 2026-08-06 · S02 设计启动

- 完成：旧实例占用 3210 的诊断与处置（用户授权）；护航在合并后代码上复测通过；D1–D6 设计决策获用户确认；S02 设计稿（draft）产出并链接入 NOW。
- 决定：S02 采用独立 Git Inspector + Project Boundary Service + 主页面新 view；只读零写入；服务端 `projects.local.json` 持久化；风险 medium。
- 下一步：用户批准设计稿 → DoR 补齐 → 实现计划 → 建分支开工。

### 2026-08-06 · S01 收尾合并

- 完成：S01 验收记录文档提交后 fast-forward 合并入 `main`（`cf62d8f`），工作分支删除，事实源基线更新。
- 决定：S02「Git 项目安全边界」为下一设计对象；设计决策 D1–D6 待用户确认。
- 下一步：用户确认 D1–D6 后产出 S02 设计稿并过 Definition of Ready。

### 2026-08-05 · 产品大纲确认与 v0.1 激活

- 完成：确认产品定位、完整流程、八模块边界和长期扩展方向。
- 决定：首个版本只完成一个 Git 项目、一个 Pi Agent、一条可控任务。
- 当前：S01 为 candidate，仍处于设计阶段。
- 下一步：补齐 S01 设计并通过 Definition of Ready。

### 2026-08-04 · 项目初始化

- 完成：读取现有产品文档和代码；建立代码地图、想法池、当前状态和 AI 协作入口。
- 验证：依赖、JavaScript 语法与本地健康接口基线已记录。
