---
type: slice-design
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S05-recovery-and-overview
design_status: accepted
ready_status: accepted
risk_level: medium
created: 2026-08-26
updated: 2026-08-26
---

# S05-A「只读任务总览」设计稿

## 1. 设计结论

S05 的第一批只做一个顶层「总览 Overview」页面。页面通过一个需本机 Token 的只读聚合接口读取已有项目、执行、证据和 AI 交接事实，不建立第二套状态、不写浏览器持久化、不提供恢复或修改动作。

总览的作用是让用户在一个页面回答五个问题：当前在哪个项目、当前有没有任务、任务处于什么状态、已有哪类证据、下一步是什么。项目页仍负责项目选择与活动项目切换，Pi 执行面板仍负责启动、停止和验收操作。

## 2. 用户起点、终点与验收目标

### 起点

用户打开驾驶舱并点击顶层「总览 Overview」；项目可能为空、活动项目可能失效、任务可能空闲或正在运行。

### 终点

用户能看到与项目页和执行面板一致的只读状态，并能识别唯一下一步；离开总览后不再继续轮询，刷新不会产生新的项目、任务或配置变化。

### 验收目标

- 总览入口在顶层导航中可见，中文为主、英文为辅助。
- 活动项目存在时显示路径、分支、HEAD、改动计数、失效状态和 AI 交接文件状态。
- 当前任务存在时显示状态、任务 ID、运行时长和错误码；不显示原始任务文本、输出或 stderr。
- 证据卡显示执行、Git、验证和验收状态，以及 before/after 的安全摘要；不显示原始验证输出。
- AI 交接卡显示交接状态、文件路径和脱敏的唯一下一步；缺失或冲突时显示明确提示。
- 无活动项目、无任务、项目失效或单个接口失败时，页面显示可理解的中性/错误状态，不把缺失当作成功。
- 轮询只在总览视图可见时运行，页面切换后停止；不写入 `localStorage`、`sessionStorage` 或 IndexedDB。

## 3. 后端接口与事实源

新增认证接口：`GET /api/overview`。它只做聚合与字段白名单，不改变现有项目、执行、证据和交接接口的语义。

### 3.1 输入与权限

- 无请求体、无用户可控命令参数。
- 复用现有 `/api` 认证闸门；未授权请求返回既有安全的 401 结构。
- 只读取当前活动项目和当前任务，不接受项目路径、任务 ID 或文件路径覆盖。

### 3.2 响应契约

成功响应为 `{ ok: true, overview }`，`overview` 只允许下列字段：

```text
overview.project
  selected, activeProjectId
  active: id, repoRoot, stale, inspection, handoff
overview.execution
  available, state, runId, startedAt, durationMs, taskId, projectId, lastError
overview.evidence
  available, taskId, projectId, state, executionStatus
  before, after, gitEvidence, evidence, validation, acceptanceStatus, lastError
overview.nextAction
  text, source, state
```

字段限制：

- `project.active.inspection` 只保留分支、HEAD 摘要、改动计数、截断标记和失效信息；不返回原始 Git 输出。
- `project.active.handoff` 只保留 `state`、`currentPath`、`recordsPath` 和文件就绪摘要。
- `execution` 不返回 `task`、`output`、命令参数或 stderr，只返回状态、标识、时长和稳定错误码。
- `evidence.before/after` 只保留分支、HEAD、工作区状态和变化数量；`gitEvidence` 只返回 certainty、causality 和各类路径数量，不返回完整路径列表。
- `evidence.validation` 只保留 result、exitCode、durationMs、withheld 和 truncated；不返回 cwd、args 或 output。
- `nextAction.text` 只从受控 `docs/ai-ops/NOW.md` 的 `next_action` 字段读取，经过统一脱敏并限制长度；文件不存在、冲突或无法解析时返回 `state: unavailable`，不透传原文。

无活动项目时返回 `project.selected: false`，执行、证据和下一步使用 `available: false` 的安全空状态。没有当前任务时，`execution.state` 为 `idle`，`evidence.available` 为 `false`，这不是错误。

### 3.3 读取交接摘要

在 `src/services/ai-handoff.js` 增加只读 `readSummary({ repoRoot })`：

- 只接受已验证的仓库根目录；只读取受控标记的 `docs/ai-ops/NOW.md`。
- 仅解析 `task_status` 和 `next_action` 两个字段；不返回完整文件、不读取历史记录、不修改任何文件。
- 解析失败、文件冲突和文件缺失统一映射为 `unavailable`，不把未知内容当作 verified。

## 4. 前端结构与状态

### 4.1 页面装配

- `public/index.html` 增加顶层 `总览 Overview` tab、`#overview-view` 和其样式/脚本资源。
- `public/js/index.js` 只负责 tab 切换和总览生命周期通知；不复制项目或执行状态。
- 新增 `public/js/overview.js` 与 `public/css/overview.css`，动态内容使用安全 DOM API，不使用 `innerHTML`、浏览器持久化或 EventSource。

### 4.2 卡片布局

1. **当前项目 Project**：项目名/路径、ACTIVE、分支、HEAD、改动计数、失效和 AI 交接状态。
2. **当前任务 Task**：空闲/运行/停止/失败/完成/中断、任务 ID、运行时长和稳定错误码。
3. **证据与验收 Evidence**：执行、Git、validation、accepted/needs_review/rejected，以及 before/after 摘要。
4. **AI 交接与下一步 Handoff**：交接文件状态、当前/历史路径和脱敏 `next_action`。

卡片只读。需要操作时提供跳转按钮：项目卡跳转「项目」，任务/证据卡跳转「项目」中的执行面板；跳转不会自动启动、停止、恢复或修改任务。

### 4.3 轮询与并发

- 总览激活后立即加载一次，随后每 5 秒刷新。
- 切换到其他 tab、页面卸载或新请求开始时取消旧请求；使用请求序号忽略迟到响应。
- 单个卡片失败保留其他卡片最近一次成功状态，并显示「暂不可用 / 重试」；不把旧状态标成实时成功。

## 5. 错误、隐私与安全边界

- 认证失败沿用现有 Token 闸门，不在页面显示 Token 内容。
- 活动项目失效显示警告和“重新识别/去项目页”建议，不自动移除项目。
- 没有任务、没有证据或没有交接文件时显示 `Unknown / Pending / Not available` 等明确状态；不伪造 `accepted`。
- 总览不显示真实 Key、Token、密码、私钥、原始 stderr、命令参数、验收输出或完整任务文本。
- 不执行 shell、Pi、Git 写命令或任何文件写入；接口仅允许读取内存状态和受控交接摘要。

## 6. 测试与真实验收

### 自动化测试

- `test/overview-routes.test.js`：认证装配、字段白名单、无活动项目、无任务、失效项目、单卡片失败和敏感字段不泄露。
- `test/ai-handoff.test.js`：`readSummary` 只读、受控标记、字段解析、冲突/缺失/超长/脱敏处理。
- `test/overview-ui.test.js`：顶层 tab/view 装配、双语标签、无 `innerHTML`、无浏览器持久化、轮询启停、状态映射和跳转行为。
- 运行 `node --test`、逐文件 `node --check`、`git diff --check` 和 strict 结构校验。

### 用户验收

在隔离端口打开页面：

1. 无活动项目时确认总览显示空状态，不报成功。
2. 设置活动项目后确认项目卡与项目页分支、HEAD、改动计数一致。
3. Pi 任务运行、结束、停止或失败后确认任务卡和证据卡随状态更新。
4. 确认 AI 交接卡显示文件状态和唯一下一步，不出现 Key、Token、stderr 或原始输出。
5. 切换离开总览后确认轮询停止；刷新后确认没有新增项目、任务或配置变化。

## 7. 非目标与后续切片

- 不实现恢复、检查点创建、恢复预览、项目文件回退或自动 Git 操作；这些属于 S05 后续高风险切片。
- 不实现历史任务搜索、图表、预算、跨项目比较或远程总览。
- 不把实验性 `~/.secrets.env` 网页 Key 管理纳入总览默认凭据路径。
- 不改变现有项目选择、Pi 执行、验收命令、黑匣子写入和 AI 交接写入语义。

## 8. Definition of Ready 入口条件

- [x] 用户确认本设计与只读范围。
- [x] `/api/overview` 响应字段和敏感信息边界通过代码/安全审查。
- [x] `readSummary` 的解析失败与冲突策略通过测试设计审查。
- [x] 前端总览入口、卡片和轮询策略通过 UI 设计审查。
- [x] 实现计划明确文件范围、回滚点和测试命令。
