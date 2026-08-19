# 活动项目内嵌 Pi 任务面板 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use \`executing-plans\` to implement this plan task-by-task.

**Goal:** 让 Pi 任务输入、运行状态和 S04 验收面板只显示在当前 \`ACTIVE\` 项目卡片正下方，并在切换活动项目时移动到新项目下方。

**Architecture:** 保留单一 \`#execution-panel\` DOM 节点和现有执行状态/API；由 \`project.js\` 在活动项目的 \`project-stack\` 中挂载该节点，切换项目时移动节点而不复制状态。项目状态刷新后通过浏览器内存事件通知 \`execution.js\` 重新读取服务端活动项目，确保边界文案和任务状态同步。服务端、Pi auth、黑匣子和证据契约不变。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js 原生 test runner、Express/SSE 现有 API。

---

### Task 1: 固化“面板跟随 ACTIVE 项目”的失败测试

**Files:**
- Modify: \`test/project-ui.test.js\`
- Modify: \`test/execution-ui.test.js\`

**Step 1: Write the failing tests**

在 \`project-ui.test.js\` 增加静态契约断言：

- \`project.js\` 有单一 \`executionPanel\` 引用和 \`project-stack\` 挂载结构。
- 只有活动项目路径会挂载面板，并在无活动项目时隐藏或移除面板。
- 活动项目状态刷新会派发 \`ops:active-project-changed\` 事件。

在 \`execution-ui.test.js\` 增加静态契约断言：

- \`execution.js\` 监听 \`ops:active-project-changed\`。
- 活动项目变化会重新读取 \`/api/project/status\`，而不是创建第二个执行面板。

**Step 2: Run tests to verify they fail**

Run: \`node --test test/project-ui.test.js test/execution-ui.test.js\`

Expected: FAIL，提示缺少 \`project-stack\`、活动项目事件或监听逻辑。

**Step 3: Commit the failing tests**

Run:
\`git add test/project-ui.test.js test/execution-ui.test.js\`
\`git commit -m "test: specify active project Pi panel placement"\`

### Task 2: 将单一执行面板挂载到活动项目下方

**Files:**
- Modify: \`public/js/project.js\`
- Modify: \`public/index.html\` only if a mount comment/attribute is needed

**Step 1: Add the single-node mount behavior**

- 初始化时取得现有 \`#execution-panel\`，不创建第二个面板。
- 项目列表渲染每个项目时创建 \`project-stack\`，先放入项目卡，再在 \`project.id === activeProjectId\` 时追加 \`executionPanel\`。
- 活动项目下方的面板保持可见；没有活动项目时将面板标记为隐藏并保持在安全的非活动挂载位置。
- \`wrap.textContent = ""\` 重新渲染时只移动同一个 DOM 节点，不清空执行模块的状态、任务草稿、SSE 订阅或事件监听器。
- 项目状态加载完成后派发 \`CustomEvent("ops:active-project-changed", { detail: { activeProjectId } })\`；事件中只放项目 id，不放路径或任务文本。

**Step 2: Run the focused tests**

Run: \`node --test test/project-ui.test.js test/execution-ui.test.js\`

Expected: Task 1 tests pass；既有 DOM 安全、API 白名单和无浏览器持久化测试仍通过。

**Step 3: Commit the UI mount change**

Run:
\`git add public/js/project.js public/index.html\`
\`git commit -m "feat: anchor Pi panel to active project"\`

### Task 3: 同步执行状态并保持输入体验

**Files:**
- Modify: \`public/js/execution.js\`
- Modify: \`public/css/project.css\`
- Modify: \`public/css/execution.css\`
- Test: \`test/project-ui.test.js\`, \`test/execution-ui.test.js\`

**Step 1: Listen for active-project changes**

- 注册 \`window.addEventListener("ops:active-project-changed", ...)\`。
- 收到事件后调用现有 \`loadAll()\` 或等价状态刷新，更新 \`state.active\`、边界文案和证据摘要。
- 不重置 \`draftTask\`；移动同一面板节点时保留 textarea 文本、焦点和光标。
- 任务运行中不因活动项目切换自动停止或迁移任务；服务端仍是唯一边界事实源，错误使用现有稳定 code 和安全文案。

**Step 2: Add embedded layout styles**

- 为 \`.project-stack\` 增加纵向堆叠和间距。
- 调整嵌入状态下 \`#execution-panel\` 的 margin/padding，使它视觉上紧接活动项目卡片且不产生第二个主滚动容器。
- 保留现有运行灯、风险提示、验收状态和窄屏换行规则。

**Step 3: Run focused tests**

Run: \`node --test test/project-ui.test.js test/execution-ui.test.js\`

Expected: 全部通过，且静态测试确认没有 \`innerHTML\`、\`localStorage\`、\`EventSource\` 或非项目 API。

**Step 4: Commit state-sync and styles**

Run:
\`git add public/js/execution.js public/css/project.css public/css/execution.css test/project-ui.test.js test/execution-ui.test.js\`
\`git commit -m "feat: sync embedded Pi panel with active project"\`

### Task 4: 更新 AI 事实源与临时需求记录

**Files:**
- Modify: \`docs/NOW.md\`
- Modify: \`docs/CODEMAP.md\` only if the stable UI mount responsibility changed enough to document
- Existing design: \`docs/superpowers/specs/2026-08-20-active-project-pi-panel-design.md\`

**Step 1: Record the implemented behavior**

- 在当前 S04 记录“Pi 面板跟随 ACTIVE 项目”的需求—证据映射和验收状态。
- 记录真实启动 Pi 时使用 \`PI_AUTH_PROVIDER=aliyun-token-plan\` 的运行前提；不写入任何凭据值。
- 保持 S04 为 \`review/active\`，直到用户完成页面验收；不要把自动化通过误写为用户 accepted。

**Step 2: Run documentation checks**

Run: \`git diff --check && node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict\`

Expected: \`git diff --check\` 无输出，结构校验 PASS。

**Step 3: Commit the record**

Run:
\`git add docs/NOW.md docs/CODEMAP.md\`
\`git commit -m "docs: record active project Pi panel requirement"\`

### Task 5: 全量验证与页面验收准备

**Files:**
- No further product-code changes unless a scoped regression is found.

**Step 1: Run automated verification**

Run:
\`npm test\`
\`git ls-files '*.js' | xargs -n1 node --check\`
\`node --check test/s04-integration.test.js\`
\`git diff --check\`
\`node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict\`

Expected: all tests pass, syntax checks pass, diff check is clean, strict structural validation is PASS.

**Step 2: Start the real acceptance instance**

Use the already known ready provider without reading any credential:

\`PI_AUTH_PROVIDER=aliyun-token-plan PORT=43211 npm start\`

Then check \`http://localhost:43211\` (fallback \`http://127.0.0.1:43211\`).

**Step 3: User acceptance matrix**

- No active project: no Pi input panel is visible.
- Set project A active: the single Pi panel appears immediately below A.
- Set project B active: the same panel moves below B; A no longer shows it.
- Type a task, switch only after the task is not running, and confirm text/focus are not duplicated or lost.
- Start Pi with the explicit provider; observe output and stop behavior.
- Verify timeline, Git before/after, validation and AI handoff remain unchanged.

**Step 4: Finish gate**

Record the user’s actual result in \`docs/NOW.md\`; only then decide whether S04 can become \`done\`. Do not merge, push or delete the work branch without explicit direction.

