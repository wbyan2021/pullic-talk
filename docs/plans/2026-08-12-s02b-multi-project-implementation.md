---
type: implementation-plan
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S02b-multi-project
status: active
risk_level: medium
branch: codex/v0.1-s02b-multi-project
updated: 2026-08-12
design: ./2026-08-12-s02b-multi-project-design.md
---

# S02b Multi-Project Implementation Plan

**Goal:** The project view can register multiple Git projects, list their status (branch / last commit / change counts / stale), refresh and remove entries individually, and designate one active project as the future S03 Pi working boundary. A v1 single-project `projects.local.json` migrates to v2 without losing data.

**Architecture:** Extend the existing S02 chain in place: `ProjectBoundaryService` moves from a single `record` to a v2 map (`{ version: 2, activeProjectId, projects: { <id>: record } }`, id = sha1(repoRoot) first 12 hex chars); routes add `POST /api/project/activate` and accept optional `id` on `refresh`/`clear`; the frontend renders a project list with an ACTIVE badge. `git-inspector.js` is untouched (read-only recognition unchanged).

**Tech Stack:** Node.js ESM, Node built-in test runner, Express 4, native HTML/CSS/JavaScript.

---

## Execution rules

- Work only on `codex/v0.1-s02b-multi-project` (from `main` HEAD at branch time).
- Follow the [S02b design](./2026-08-12-s02b-multi-project-design.md). Any scope change stops work and goes back to design.
- **Zero write to any real repository.** Tests create fixture repos only inside `os.tmpdir()`; service tests use fixture state paths inside `os.tmpdir()`. Never point a test at this repository or a user repo.
- Do not read `.token` or any real credential. `projects.local.json` never contains secrets and stays out of Git.
- Do not modify: `src/services/git-inspector.js`, all escort files (`src/providers/`, `src/services/credential-store.js`, `src/services/escort-service.js`, `src/routes/escort.js`, `public/js/escort.js`, `public/css/escort.css`, escort tests), chat/terminal/install files, `public/vendor/`, `agents.config.json`, `tools.json`, `package-lock.json`, `src/server.js` (assembly is expected to need no change; if it does, stop and record why).
- Error responses keep the escort shape: `{ ok: false, code, message, action, retryable }`.
- One commit per task; commit only known slice files; leave unrelated user changes unstaged.
- TDD: write failing tests first within each task, then implement, then run the task's test file plus `npm test`.

---

## Task 1: v2 data model + v1→v2 migration (service layer)

**Files:**
- Test: `test/project-boundary.test.js` (rewrite for v2)
- Modify: `src/services/project-boundary.js`

### Step 1.1: Failing tests — migration and multi-project model

Rewrite `test/project-boundary.test.js` around a mock inspector (same style as S02: no real git; state path inside `mkdtempSync`). Cover:

- **Migration**: write a real v1 fixture (`{ version: 1, project: {...} }` with full `selectionSnapshot`/`lastInspection`) to the state path; first `getStatus()` must return the project in `projects` with a 12-char `id`, `activeProjectId === id`, and every v1 field preserved; the state file on disk must afterwards parse as `version: 2`.
- **Corrupted file** still degrades to empty state (`{ projects: [], activeProjectId: null }`).
- **Empty start**: no file → empty status.
- **select() upsert**: two different paths → two entries ordered by `selectedAt` ascending; selecting the same repoRoot again updates the entry in place (still one project, refreshed `selectedAt`/`lastInspection`); `select()` never changes `activeProjectId`.
- **Payload shape**: each project payload carries `id`, `inputPath`, `resolvedPath`, `repoRoot`, `selectedAt`, `stale`, `inspection`, `selectionSnapshotAt`; `getStatus()` returns `{ projects, activeProjectId, active }` where `active` is the active project's payload or `null`.
- **stale per project**: when a fixture repoRoot directory is removed, only that project reports `stale: true`.

### Step 1.2: Implement v2 model

- State: `{ version: 2, activeProjectId, projects }`; `id = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12)`.
- `ensureLoaded()`: accept v1 (`version === 1 && project`) → wrap into v2, set active, **persist v2 immediately**; accept v2 with structural validation (each entry must have string `inputPath`/`repoRoot`/`selectedAt` plus `selectionSnapshot`/`lastInspection`); anything else → warn + empty state.
- `persist()`: temp file + rename, unchanged mechanism; always writes v2 (empty map allowed). `clear()` no longer deletes the file — it persists v2 with the entry removed (file with empty `projects` is the canonical empty state).
- Keep `sanitizeInspection` and error wrapping unchanged.

Run: `node --test test/project-boundary.test.js` → green; then `npm test` (old route/UI tests will fail — expected until Task 3/4; record and move on).

**Commit:** `feat(project): v2 multi-project state model with v1 migration`

---

## Task 2: Active project + per-id refresh/clear (service layer)

**Files:**
- Test: `test/project-boundary.test.js`
- Modify: `src/services/project-boundary.js`

### Step 2.1: Failing tests

- `setActive(id)`: sets `activeProjectId`; unknown id → `ProjectBoundaryError("project_not_found")`.
- `refresh(id)`: re-inspects that project's `repoRoot` and updates only its `lastInspection`; `refresh()` without id refreshes the active project (S02 compatibility); no active and no id → `no_project_selected`; unknown id → `project_not_found`; inspector reporting `path_not_found`/`not_a_git_repo` → `project_stale`.
- `clear(id)`: removes only that entry; clearing the active project resets `activeProjectId` to `null`; `clear()` without id clears the active project; unknown id → `project_not_found`; no active and no id → `no_project_selected`.

### Step 2.2: Implement

Add `setActive`, extend `refresh`/`clear` with optional id resolution (`id ?? activeProjectId`, then lookup). Keep all existing error codes.

Run: `node --test test/project-boundary.test.js` → green.

**Commit:** `feat(project): active project and per-id refresh/clear`

---

## Task 3: Route contract extension

**Files:**
- Test: `test/project-routes.test.js` (rewrite for v2 shapes)
- Modify: `src/routes/project.js`

### Step 3.1: Failing tests (mock boundary service, supertest-style via inject helper as in S02)

- `GET /api/project/status` → `{ ok: true, projects: [safeProject...], activeProjectId }`; each item whitelisted to `id, inputPath, resolvedPath, repoRoot, selectedAt, stale, inspection, selectionSnapshotAt`; no `selected` field, no extra keys.
- `POST /api/project/select` → unchanged request (`{ path }`), response `{ ok: true, project }` for the single upserted project.
- `POST /api/project/activate` with `{ id }` → `{ ok: true, activeProjectId }`; missing/empty id → 400 `invalid_request`-style fixed error; unknown id → mapped error.
- `POST /api/project/refresh` / `clear` with optional `{ id }` → `{ ok: true, project }` / `{ ok: true }`.
- New error mapping: `project_not_found` → HTTP 404, fixed Chinese copy ("找不到指定的项目，可能已被移除。" / action "刷新列表后重试", retryable false). All existing codes keep their status/copy.

### Step 3.2: Implement

Extend `ERROR_INFO`/`SAFE_HTTP_STATUS`, add `activate` route with body validation (`id` must be a non-empty string), thread optional `id` through `refresh`/`clear`, replace `safeProject` list handling (`safeProjectList`). Keep field whitelist discipline.

Run: `node --test test/project-routes.test.js` → green; `npm test` (UI test may still fail until Task 4).

**Commit:** `feat(project): multi-project route contract with activate endpoint`

---

## Task 4: Project list UI

**Files:**
- Test: `test/project-ui.test.js` (extend static regressions)
- Modify: `public/js/project.js`, `public/css/project.css`

### Step 4.1: Failing static/UI tests

Extend `test/project-ui.test.js` (static-source assertions, same style as S02):

- `project.js` calls the five endpoints: `status`, `select`, `activate`, `refresh`, `clear`.
- No `innerHTML`, no `outerHTML`, no `insertAdjacentHTML`, no `localStorage`/`sessionStorage` (existing rule kept).
- Contains ACTIVE badge rendering (`textContent`-built), per-card 设为活动/刷新/移除 buttons, and a double-click confirm flow for removal.
- `project.css` defines the list/card/badge styles referenced by the JS.

### Step 4.2: Implement list UI

- State: `{ projects: [], activeProjectId, loading, busy, error }`; `confirmingId` replaces single `confirming` (confirm state is per card).
- Render: head + select form (always visible at top) + project list (cards in `selectedAt` order) or empty state; error card above list.
- Card: reuse S02 card sections (paths, branch badge, head commit, counts grid, entries, remotes); header shows repoRoot dir name + ACTIVE badge when `id === activeProjectId`; stale cards render the existing stale error style and disable 刷新/设为活动.
- Actions per card: 设为活动 (hidden when active, POST `activate` `{ id }`), 刷新 (POST `refresh` `{ id }`), 移除 (double-click confirm, POST `clear` `{ id }`).
- After every mutation, reload `status` (server is source of truth); no browser persistence.
- CSS: list layout, ACTIVE badge, per-card action row; keep narrow-screen behavior consistent with S02.

Run: `node --test test/project-ui.test.js` → green; `npm test` → all green.

**Commit:** `feat(project): multi-project list UI with active badge`

---

## Task 5: Full automated verification + forbidden-path audit

```bash
npm test                                                  # 全量绿（110 + 新增）
git ls-files '*.js' | xargs -n1 node --check
git diff --check main...HEAD
git diff --name-only main...HEAD                          # 审计：仅允许范围内文件
PORT=43215 npm start &                                    # 隔离端口
curl -s http://127.0.0.1:43215/api/health                 # ok: true
curl -s http://127.0.0.1:43215/api/project/status         # 无 Token → 401
kill %1
```

禁改路径审计清单：`src/services/git-inspector.js`、护航全部文件、群聊/终端/安装、`public/vendor/`、`agents.config.json`、`tools.json`、`package-lock.json`、`src/server.js` 必须不出现在 diff 中。

**Commit:** 仅当验证暴露问题需要修复时产生；否则无提交，只把证据回写 NOW.md。

---

## Task 6: User real acceptance (manual, with user)

前置：先把真实 `projects.local.json` 复制为 `projects.local.json.bak`（不提交），验收通过后由用户决定是否删除。

用分支代码在 `3210`（或隔离端口）启动服务，用户完成：

1. **迁移**：打开项目 view，确认「个人资产管理」项目仍在、状态正确且已自动标记为活动项目；`projects.local.json` 已为 v2 结构。
2. **多项目录入**：再录入 2 个真实项目（如声音世界、本仓库）；重复录入其中一个，确认不产生重复条目。
3. **活动切换**：切换活动项目，确认 ACTIVE 徽标跟随；`GET /api/project/status` 暴露正确 `activeProjectId`。
4. **逐项刷新/移除**：刷新一项；移除一项（双击确认）；移除活动项目后活动标记置空。
5. **零写入证明**：验收前后对每个涉及仓库执行 `git status --porcelain` 与 `git stash list`，结果完全一致。
6. **旧链路回归**：护航对话、群聊、终端各做一次冒烟。

全部通过后：标记 S02b `done`，回写 NOW.md 需求—证据映射与验证证据，fast-forward 合并回 `main` 并删除工作分支，更新稳定基线。

---

## Done criteria (slice level)

- [ ] `npm test` 全绿（含迁移夹具、多项目增删、活动项目、路由契约、UI 静态回归）
- [ ] `node --check`、`git diff --check`、隔离端口健康检查、401 闸门通过
- [ ] 禁改路径 diff 审计通过
- [ ] 用户真实验收 6 项全部通过，证据回写 NOW.md
- [ ] fast-forward 合并回 `main`，工作分支删除，基线更新
