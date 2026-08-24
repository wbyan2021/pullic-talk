# 项目页中英文对照 Implementation Plan

> **For the coding agent:** follow this plan task by task; keep the Chinese label primary and preserve machine-readable values.

**Goal:** 在项目页与 Pi 受控运行面板中为固定标签、状态、时间线和操作按钮提供中文主标签与英文辅助标签，降低英文枚举对用户理解的门槛，同时不改变后端契约、路径、分支、提交号、任务文本或验收语义。

**Architecture:** 两个前端脚本各自使用安全 DOM helper 生成 `bilingual` 节点；固定状态通过白名单映射转换为中文/英文 pair，未知值回退为“未知 Unknown”并保留原始机器值。CSS 统一控制英文辅助字号、颜色、间距和窄视口换行。

**Tech Stack:** 原生 JavaScript DOM API、原生 CSS、Node.js `node:test` 静态 UI 契约。

### Task 1: 建立双语渲染契约与项目页映射

**Files:**
- Modify: `public/js/project.js`
- Modify: `public/css/project.css`
- Test: `test/project-ui.test.js`

**Steps:**
1. 先补静态契约测试，要求项目页包含双语 helper、ACTIVE/分支/改动状态映射、AI 交接与主要按钮英文辅助文案。
2. 运行 `node --test test/project-ui.test.js`，确认新增契约在实现前失败。
3. 增加安全的双语节点和按钮/键值/计数渲染 helper；固定标签显示中文主文案，英文使用辅助节点；动态路径、分支、提交、任务和 Git 原始状态不改写。
4. 将项目页用户可见的 ACTIVE、Git 分支状态、改动计数、AI 交接状态、折叠/识别/移除等标签改为双语；未知状态统一显示“未知 Unknown”。
5. 增加英文辅助样式与窄视口换行规则。
6. 运行项目 UI 定向测试和逐文件语法检查。

### Task 2: 建立 Pi 面板状态、时间线和验收映射

**Files:**
- Modify: `public/js/execution.js`
- Modify: `public/css/execution.css`
- Test: `test/execution-ui.test.js`

**Steps:**
1. 补静态契约测试，覆盖 `idle/running/stopping/stopped/failed/exited/pending/not_run/passed/needs_review/accepted/rejected` 的中英文映射，以及标题、状态行、时间线、验证和验收按钮。
2. 运行 `node --test test/execution-ui.test.js`，确认新增契约在实现前失败。
3. 增加安全的双语节点、状态 pair 和内联状态行 helper；认证失败、空闲、运行、停止、失败、结束、Git before/after、validation 与验收结果均提供中文主文案和英文辅助值。
4. 将主要按钮和区域标题改为双语；保留程序、参数、路径、分支、提交哈希和用户任务原文。
5. 增加执行面板英文辅助样式，保证小屏下可换行且不横向溢出。
6. 运行执行 UI 定向测试和逐文件语法检查。

### Task 3: 回归验证与交付记录

**Files:**
- Verify only: `public/js/project.js`, `public/js/execution.js`, `public/css/project.css`, `public/css/execution.css`, related tests.
- Update only with fresh evidence: `docs/NOW.md` and `docs/ai-ops/NOW.md` if the implementation evidence changes the recorded next action.

**Steps:**
1. 运行 `node --test test/project-ui.test.js test/execution-ui.test.js`。
2. 运行 `npm test`，区分本次回归与工作区既有 members 改动造成的失败。
3. 运行 `git ls-files '*.js' | xargs -n1 node --check`、`git diff --check` 和 `node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict`。
4. 检查 `git diff` 只包含本次允许范围，不暂存用户现有改动、备份、服务器 pid 或目标项目 `docs/ai-ops/`。
5. 提交双语实现与测试，保留 S04 的真实 Pi 验收状态为 review/needs_review，不能把 UI 双语完成冒充产品验收完成。
