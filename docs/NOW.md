---
type: milestone
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
status: active
stage: design
current_slice: S02-git-safety-boundary
slice_status: ready
work_branch: none（S02 分支 `codex/v0.1-s02-git-safety-boundary` 待 Ready 后从下方基线创建）
base_commit: 40c5e4824e05f69c6f450f0c07fddf44e5977def
risk_level: high
last_verified_commit: cf62d8ffdbf8dafbce4fca8062419bf345a2a29c
updated: 2026-08-06
---

# 当前版本：v0.1 · 第一次可控任务

> S01 已通过用户真实验收：Keychain 保存、替换、删除与图形核对，DeepSeek 连接检测与真实回复，以及 Pi 不可用时护航独立可用均无问题。自动化验证也已在候选提交上复跑通过；S01 现标记为 `done`。

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
- 一个由用户主动选择的 Git 项目；
- 一条任务及一个受控执行批次；
- 最小统一状态与事件、项目边界、恢复点、飞行控制、验收证据和黑匣子记录。

## 明确不做

- 不做多 Agent 正式任务编排；现有群聊保留，但不进入 v0.1 主闭环。
- 不做非 Git 项目的完整快照恢复。
- 不做远程控制、移动端、插件生态、跨平台或团队协作。
- 不做完整 AI IDE、通用 AI 工具箱或云端模型托管。
- 不重写现有 Node / Express / WebSocket / SSE / node-pty 技术栈。

## 风险等级与验证策略

**当前切片风险：高。** 原因不是代码量，而是它同时接触真实 API 凭据、付费外部服务和面向用户的故障判断。开工前必须完成设计确认；实现时先建立可替换边界和自动化错误映射测试，完成前再进行一次不暴露 Key 的真实人工验收。

| 依赖 | 风险 | 当前证据 | 后续最小验证 |
|---|---|---|---|
| macOS 钥匙串 | 系统授权策略与 `security` 的 TTY 行为可能因本机环境不同 | 11 项默认测试与 12/12 无写入 macOS 探针验证固定条目、受控 PTY 提示、幂等删除、无明文回退和超时回收；首次真实保存发现并修复普通 stdin 缺陷 | 用户刷新修复后的网页，完成一次保存、替换、删除，并在 Keychain Access 核对固定条目 |
| DeepSeek API | 错误协议、模型可用性和真实网络状态可能变化 | 13 项 Provider 测试已覆盖成功、401/402/429/5xx、网络、超时和非法响应；均为假 Key/Mock | 用户用自己的 Key 完成连接检测和一次真实护航回复 |
| Pi CLI | 登录、模型配置、输出格式和停止行为可能变化 | 当前代码能发现 CLI，但未形成受控任务契约 | S03 前固定版本并做最小真实调用 |
| 本机 Shell 与子进程 | 继承当前用户权限，不是真正沙箱 | 当前已有 node-pty 和命令启动能力 | 明确工作目录、子进程归属、暂停与终止语义 |
| Git 工作区 | 用户可能已有分支、未提交改动和未跟踪文件 | 当前仓库本身已有未知改动 | S02 先验证只读识别和保护策略 |
| 自动化验证 | 暂无 CI 和 lint，外部服务不能由 Mock 代替 | 已加入 Node 原生测试入口；62 项默认测试、12/12 macOS 无写入探针、语法、差异、严格状态校验和隔离端口健康检查通过 | 用户真实验收后把结果回写本文件；后续版本再评估 CI |
| 默认端口 3210 | 曾被 7 月 31 日的旧实例占用 | 2026-08-06 经用户授权结束旧实例（PID 25068），S01 合并后的服务已在 3210 正常运行 | 无需进一步处理 |

验证深度：

1. 单元测试覆盖 Keychain 调用边界、Key 不进入命令参数、DeepSeek 响应与错误归类。
2. 语法、差异和隔离端口健康检查覆盖装配回归。
3. 用户在网页中完成一次真实 Key 保存、连接检测、护航回复、替换与删除验收；Key 不通过聊天或终端交给 AI。
4. 若真实服务、钥匙串权限或错误协议与设计不一致，切片退回 `candidate`，不得用“测试里模拟成功”代替真实证据。

## 版本验收标准

- [ ] 用户可安全配置 DeepSeek，并独立使用护航 AI。
- [ ] 用户可选择一个 Git 项目，既有改动不会被覆盖或丢弃。
- [ ] Pi 只能在已选择的项目边界内开始受控任务。
- [ ] 用户可观察状态，并能安全暂停、继续和终止执行。
- [ ] 完成结果包含文件变化、命令或测试等可检查证据。
- [ ] 任务全过程生成脱敏记录，并可从明确恢复点恢复。
- [ ] 用户实际完成一条真实任务，而不只是看到功能演示。

## 计划切片

| 顺序  | 切片         | 可观察结果                        | 状态        |
| --- | ---------- | ---------------------------- | --------- |
| S01 | 护航 AI 独立上线 | 配置 DeepSeek 后能检测连接、对话并显示可靠状态 | done      |
| S02 | Git 项目安全边界 | 选择项目后识别并保护现有工作区状态            | candidate |
| S03 | Pi 受控运行    | Pi 只在项目内启动，并可暂停、继续、终止        | pending   |
| S04 | 证据与黑匣子     | 可查看状态时间线、文件变化和验收证据           | pending   |
| S05 | 恢复与总览闭环    | 可恢复到检查点，并从总仪表完成整条任务          | pending   |

## 代码工作区

- 代码地图：[CODEMAP.md](CODEMAP.md)
- 稳定分支：`main`
- 稳定基线：`cf62d8ffdbf8dafbce4fca8062419bf345a2a29c`（S01 已于 2026-08-06 fast-forward 合并入 main）
- 产品工作分支：无；S02 达到 Ready 后从新基线创建
- 依赖检查：`npm ls --depth=0`
- 语法检查：`git ls-files '*.js' | xargs -n1 node --check`
- 自动化测试：`npm test`
- 健康检查：`PORT=43211 npm start` 后访问 `/api/health`
- 当前状态：S01 已合并入 main 并删除工作分支；`npm test` 62/62 在合并提交 `cf62d8f` 上通过；默认端口 3210 的旧实例（2026-07-31 启动，早于 S01）已经用户授权结束，当前服务运行于 3210；本地 main 领先 `origin/main` 15 个提交，是否推送由用户决定。

## 当前切片

### S02 · Git 项目安全边界（candidate，设计中）

### 目标

用户选择一个本地 Git 项目（手动输入路径）后，系统对其进行只读识别并记录工作区状态；全程零写入，服务重启后选择仍在、可刷新、可移除。

### 验收标准

- [ ] 可选择真实 Git 项目，准确识别仓库根、分支/detached、已暂存/未暂存/未跟踪/冲突、最近提交与远端。
- [ ] 非 Git 目录、不存在路径、文件、禁止根（`/` 或主目录）均返回可区分的错误。
- [ ] 选择持久化在服务端 `projects.local.json`（被忽略），重启后仍在；路径失效明确显示失效。
- [ ] 识别只读：代码层无 Git 写动词 + 验收仓库前后 `git status` 一致。
- [ ] 移除幂等且需就地确认；UI 仅用 `textContent` 类安全渲染。
- [ ] 护航、群聊、终端、安装链路不受影响；Pi 不可用不影响项目选择。

### 明确不做

- 不创建恢复点/stash/commit/branch（S05）；不强制执行 Pi 边界（S03）。
- 不做目录浏览 API 或原生文件选择器；不做多项目。
- 不动护航、群聊、终端、安装与启动代码。

### 允许修改范围

- 严格限定在 [S02 设计稿 §10](plans/2026-08-06-s02-git-safety-boundary-design.md#10-精确修改范围)：9 个新增文件 + `src/server.js`、`public/index.html`、`.gitignore`（`.gitignore` 暂存策略实现时单独征求用户同意）。
- 不修改 `src/agent-caller.js`、`src/routes/api.js`、`public/js/chat.js`、`public/vendor/`、`tools.json`、`.token`、`agents.config.json` 与 S01 护航全部文件。

### Definition of Ready

- [x] 目标可用一句话讲清楚
- [x] 起点和终点可观察
- [x] 验收标准可执行到产品行为层
- [x] 非目标明确
- [x] 修改范围精确到文件或目录
- [x] 代码入口和验证命令明确
- [x] 基线状态已记录
- [x] 唯一工作分支名称已确定（`codex/v0.1-s02-git-safety-boundary`，自 `main` 当前 HEAD）
- [x] 未知改动已识别并有保护方案
- [x] 关键决策已确认（D1–D6，2026-08-06 用户确认）
- [x] 设计稿获用户批准（2026-08-06 “全部同意”，标记 `accepted`）
- [x] 实现计划已产出（[S02 实现计划](plans/2026-08-06-s02-git-safety-boundary-implementation.md)，6 个任务 TDD）

S01 已合并入 `main`（基线 `cf62d8f`，合并后复测通过）；其需求—证据映射保留在下方存档段落。`.gitignore` 的用户改动（`.superpowers/`）保持未提交、未暂存；实现时新增 `projects.local.json` 行的暂存策略需单独征求用户同意。

## 需求—证据映射（S01 存档记录）

| 需求 | 自动证据 | 真实/人工证据 | 当前状态 |
|---|---|---|---|
| Key 可录入、替换、删除且只显示脱敏状态 | Credential Store 与路由测试通过；API 状态响应使用字段白名单 | 用户在网页完成保存、替换、删除，并在 Keychain Access 核对固定条目 | 自动与真实验收通过 |
| Key 不进入仓库、普通配置、日志或进程参数 | 测试断言假 Key 只经受控 PTY 传入且不在 argv/环境/输出/错误/响应；源码无浏览器持久化；差异检查通过 | 用户确认验收全过程未在聊天、终端、Git 状态、普通配置或日志中暴露 Key | 自动与真实验收通过 |
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

## 阻塞

- S01 无阻塞，已完成。
- 下一切片尚未定义具体重构目标、边界和验收标准；在它达到 Definition of Ready 前，不修改产品代码。

## 唯一下一步

S02 已达 Definition of Ready：从基线 `40c5e48` 创建 `codex/v0.1-s02-git-safety-boundary`，按 [S02 实现计划](plans/2026-08-06-s02-git-safety-boundary-implementation.md) 从 Task 1（Git Inspector）开始 TDD 实现；开工后将切片标记 `active`。

## 最近交接

### 2026-08-06 · S02 Ready，准备开工

- 当前阶段：`design → build`；切片：`S02-git-safety-boundary (ready)`；基线：`40c5e48`（main）；待建分支：`codex/v0.1-s02-git-safety-boundary`。
- 已完成：S02 设计稿获用户批准（accepted）；DoR 全部满足；[实现计划](plans/2026-08-06-s02-git-safety-boundary-implementation.md)产出（6 任务 TDD，含零写入证明与三场景验收）。
- 未完成：建分支、Task 1–6 实现与验收。
- 恢复动作：先读本文件；从实现计划 Task 1 开始；开工后把 NOW.md 的 `slice_status` 改为 `active` 并记录工作分支。

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
