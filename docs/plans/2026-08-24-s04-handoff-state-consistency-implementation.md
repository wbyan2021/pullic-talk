# S04 AI 交接状态一致性修复 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让项目页依据真实交接文件状态显示并修复“已启用但文件缺失”的 AI 交接状态。

**Architecture:** 在 AI 交接服务中增加固定路径的只读状态检查，并让显式启用/修复操作安全地补齐缺失的受控目录和初始 `NOW.md`。项目状态接口只返回白名单字段，前端按 `not_enabled`、`repair_required`、`ready` 和 `conflict` 显示对应操作；已有受控或用户文件始终不覆盖。

**Tech Stack:** Node.js ESM、Express 路由、原生 DOM、Node `node:test`、原子文件写入。

---

### Task 1: 扩展 AI 交接服务的文件状态与安全初始化

**Files:**
- Modify: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/src/services/ai-handoff.js`
- Test: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/test/ai-handoff.test.js`

**Step 1: Write the failing tests**

Add tests for:

- a fresh repository reporting missing handoff files without exposing file contents;
- explicit enablement creating `AGENTS.md`, `docs/ai-ops/records/`, and a minimal managed `docs/ai-ops/NOW.md`;
- the initial document using `needs_review`, unknown facts, and a truthful unique next action;
- an existing managed `NOW.md` remaining byte-for-byte unchanged during repair;
- an existing non-managed `NOW.md` returning `handoff_conflict` without creating or overwriting anything.

**Step 2: Run the focused tests to verify failure**

Run: `node --test test/ai-handoff.test.js`

Expected: FAIL because the inspection and initialization contract does not exist.

**Step 3: Implement the minimal service contract**

- Extend the injected filesystem adapter with only the existing `access`, `mkdir`, `readFile`, `rename`, and `writeFile` primitives.
- Add `inspectProject({ repoRoot })`, returning only `agentsPointer`, `current`, `records`, and `state` values.
- Keep `writeCurrent` conflict-safe and use a fixed initial input for a missing current file.
- Make `enableProject` append the managed `AGENTS.md` pointer when explicitly authorized, create the records directory, and create the initial current handoff only when absent.
- Preserve managed current files and reject ordinary current files.

**Step 4: Run the focused tests to verify success**

Run: `node --test test/ai-handoff.test.js`

Expected: PASS, including existing redaction and atomic-write tests.

**Step 5: Commit**

```bash
git add src/services/ai-handoff.js test/ai-handoff.test.js
git commit -m "fix: initialize project AI handoff safely"
```

### Task 2: Expose actual handoff state through project routes

**Files:**
- Modify: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/src/routes/project.js`
- Test: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/test/project-routes.test.js`

**Step 1: Write the failing tests**

Add route tests asserting:

- `GET /api/project/status` merges only safe handoff file-state fields;
- an enabled project with missing files returns `repair_required`;
- a project with ready files returns `ready`;
- secrets or arbitrary service fields never appear in the response;
- the existing enable route returns the repaired state after the writer completes.

**Step 2: Run the focused tests to verify failure**

Run: `node --test test/project-routes.test.js`

Expected: FAIL because status does not inspect handoff files and the safe whitelist omits file state.

**Step 3: Implement the route changes**

- Add safe `handoff.state` and fixed path status fields to the response whitelist.
- For each project, call the optional handoff inspector only when available; leave legacy behavior intact when the service is absent.
- Map persisted `enabled` plus actual inspection to `not_enabled`, `repair_required`, `ready`, or `conflict` without returning raw paths or errors.
- Keep the explicit enable route authenticated and return the repaired project payload.

**Step 4: Run the focused tests to verify success**

Run: `node --test test/project-routes.test.js`

Expected: PASS, including all existing project route tests.

**Step 5: Commit**

```bash
git add src/routes/project.js test/project-routes.test.js
git commit -m "fix: expose project handoff readiness"
```

### Task 3: Make the project page show and repair stale handoff state

**Files:**
- Modify: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/public/js/project.js`
- Test: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/test/project-ui.test.js`

**Step 1: Write the failing tests**

Extend static UI assertions to require:

- visible `repair_required` handling;
- the `修复 AI 交接` action;
- the ready-state wording;
- reuse of `/api/project/handoff/enable` for the repair action.

**Step 2: Run the focused tests to verify failure**

Run: `node --test test/project-ui.test.js`

Expected: FAIL because the current renderer returns early for every enabled handoff and has no repair action.

**Step 3: Implement the minimal renderer change**

- Keep all dynamic output on safe DOM APIs.
- Render a clear repair message and button when `handoff.state === "repair_required"`.
- Render a conflict message without a write button when `handoff.state === "conflict"`.
- Keep the existing enable button for unconfigured projects and the current/history paths for `ready`.

**Step 4: Run the focused tests to verify success**

Run: `node --test test/project-ui.test.js`

Expected: PASS.

**Step 5: Commit**

```bash
git add public/js/project.js test/project-ui.test.js
git commit -m "fix: show handoff repair action in project view"
```

### Task 4: Regression verification and handoff record

**Files:**
- Verify only; do not stage existing user-owned changes in `README.md`, `public/chat.html`, `public/css/chat.css`, `public/js/chat.js`, `src/agent-caller.js`, `src/config.js`, `src/routes/api.js`, `test/agent-caller.test.js`, or `test/chat-flow.test.js`, `test/chat-ui.test.js`.
- Update only after fresh evidence: `/Users/bz01/Desktop/文博知识库/10_vibcoding/pullic-talk/docs/NOW.md` if the user acceptance result is known.

**Step 1: Run targeted regression tests**

Run: `node --test test/ai-handoff.test.js test/project-routes.test.js test/project-ui.test.js test/project-boundary.test.js`

Expected: PASS.

**Step 2: Run the full suite and syntax checks**

Run: `npm test`

Expected: all tests pass, with the prior baseline count plus the new assertions.

Run: `git ls-files '*.js' | xargs -n1 node --check`

Expected: no syntax errors.

**Step 3: Run structural validation**

Run: `node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict`

Expected: PASS, with existing user-owned changes still present and uncommitted.

**Step 4: Check the isolated page**

After the already-running service is available at `http://localhost:43211/`, refresh the current `pullic-talk` project page. Confirm the stale state now shows `修复 AI 交接`; only the user's click may perform the project-file write.

**Step 5: Commit only implementation files**

```bash
git status --short
git diff --check
git add src/services/ai-handoff.js src/routes/project.js public/js/project.js test/ai-handoff.test.js test/project-routes.test.js test/project-ui.test.js
git commit -m "fix: repair stale project AI handoff state"
```

Do not add `AGENTS.md`, `projects.local.json.bak`, or any unrelated modified/untracked path.
