---
type: design-spec
project: AI·OPS COCKPIT
milestone: v0.1-first-controlled-mission
slice: S04-evidence-and-blackbox
status: implemented
date: 2026-08-24
implemented_commit: f066b9f
verification: 项目页/执行面板定向测试 25/25；窄视口真实视觉验收仍待用户确认
---

# 项目页中英文对照设计

## 目标

让不熟悉英文的用户在项目页和 Pi 受控运行面板中同时理解中文含义与原始机器状态。中文作为主标签，英文作为紧随其后的辅助标签；分支名、提交号、路径、provider 名称和用户任务原文保持原样。

## 范围

仅修改项目页和 Pi 受控运行面板：

- 项目卡片、ACTIVE 标记、Git 状态和改动计数；
- AI 交接记录；
- Pi 工作边界与风险提示；
- Pi 认证、空闲、运行、停止、失败和结束状态；
- 任务时间线、Git before/after、验证状态和验收状态；
- 验收命令输入、预览、确认和收口按钮。

不修改聊天、护航、终端、安装和其他页面。

## 交互与视觉规则

1. 固定标签使用 `中文 English` 形式，中文字号和颜色为主，英文使用较小、较浅的辅助样式。
2. 状态使用统一映射，不直接把裸枚举值展示给用户：
   - `idle` → `空闲 Idle`；
   - `running` → `执行中 Running`；
   - `stopping` → `停止中 Stopping`；
   - `stopped` → `已停止 Stopped`；
   - `failed` / `error` → `失败 Failed`；
   - `exited` / `done` → `已结束 Completed`；
   - `unknown` → `未知 Unknown`；
   - `pending` → `待处理 Pending`；
   - `not_run` → `未运行 Not Run`；
   - `passed` → `通过 Passed`；
   - `needs_review` → `需要复核 Needs Review`；
   - `accepted` → `验收通过 Accepted`；
   - `rejected` → `已拒绝 Rejected`。
3. 按钮和区域标题也使用同样规则，例如 `启动 Pi Start Pi`、`刷新状态 Refresh Status`、`预览验收命令 Preview Validation Command`。
4. 机器可读值仍保留在辅助英文中，不能翻译或改写路径、分支、提交哈希、任务文本和 provider。
5. 动态文本继续使用安全 DOM API；不引入浏览器持久化，也不把英文对照写入项目交接或黑匣子事实。

## 实现边界

- `public/js/project.js`：项目卡片、AI 交接、Git 标签和项目操作按钮。
- `public/js/execution.js`：Pi 状态、时间线、验证和验收动作。
- `public/css/project.css`、`public/css/execution.css`：英文辅助文本的字号、颜色、间距和窄视口布局。
- `test/project-ui.test.js`、`test/execution-ui.test.js`：静态契约和关键中英文映射覆盖。

## 验收标准

- [x] 项目页所有用户可见的英文状态都有中文解释和英文原值。
- [x] Pi 面板的认证、运行、停止、失败和结束状态都有中英文对照。
- [x] 时间线的执行、Git 证据、验收、before/after 和 validation 状态都有中英文对照。
- [x] 主要按钮和区域标题都有中英文对照，路径、分支、提交号保持不变。
- [ ] 窄视口下英文辅助文本不造成横向溢出或裁切（需用户页面复验）。
- [x] 项目页和执行面板定向测试通过；全量回归的路由监听限制已单独复跑确认。

## 非目标与风险

- 不做全站语言切换、语言偏好持久化或翻译系统。
- 不修改后端状态契约，不改变 Pi 执行和验收语义。
- 英文辅助文案只改善可理解性，不改变事实等级和验收结论。
