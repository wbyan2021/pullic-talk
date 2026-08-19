# S04「证据与黑匣子」Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为 Pi 受控任务建立可验证的本地事实账本，并在用户项目内生成脱敏、可被 Codex/Pi 读取的 AI 交接记录。

**Architecture:** 保留 S03 的 PiExecutor 作为唯一 Pi 进程边界，在其外增加 TaskEvidence 协调层。协调层在启动前获取 Git 快照、订阅 Pi 事件、在终态获取后置快照，并把安全事件写入产品本地 blackbox.local/。用户确认验收命令后，HandoffWriter 原子写入项目内 docs/ai-ops/NOW.md 与不可覆盖的历史记录；护航、群聊、终端和安装主链路不参与事实记录。

**Tech Stack:** Node.js 18+、Express 4、原生 Node test runner、child_process.spawn（shell: false）、现有 Git Inspector、原生 HTML/CSS/JavaScript、SSE。

---

## 0. Implementation guardrails

- 先从本计划提交后的当前 main HEAD 创建唯一分支 codex/v0.1-s04-ai-handoff-blackbox；不得在 main 上写产品代码。
- 进入实现前，把 docs/NOW.md 的当前切片更新为 S04 ready，记录本计划、基线、high 风险和用户改动保护策略；不要把 S04 标为 active，直到第一项产品代码真正开始。
- 保留未跟踪的 projects.local.json.bak，不读取、不暂存、不删除。
- 所有目标项目写入都必须经过用户显式启用交接记录；产品不自动提交 Git。
- 黑匣子和命令输出不得把 Key、Token、密码、私钥、环境变量或未脱敏 stderr 写入磁盘。
- 每个任务保持 WIP=1；每一步完成后运行针对性测试并小步提交。
- 设计依据：[S04 设计稿](../superpowers/specs/2026-08-19-s04-ai-handoff-blackbox-design.md)。

## Task 1: Prepare S04 Ready state and branch

**Files:**
- Modify: docs/NOW.md
- Modify: docs/CODEMAP.md only if the new stable modules/commands are introduced during preparation
- Create branch: codex/v0.1-s04-ai-handoff-blackbox

**Step 1: Verify the recorded baseline and worktree**

Run:

~~~bash
git status --short --branch
git rev-parse HEAD
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/inspect-project-state.mjs .
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs .
~~~

Expected: HEAD matches the latest documentation-plan commit, only projects.local.json.bak is untracked, and structural validation passes.

**Step 2: Update the project fact source**

In docs/NOW.md, record S04 as the single current slice, link the accepted design and this implementation plan, set the implementation baseline to the exact current main HEAD, retain product-code verification at 13966b5, set risk to high, and preserve the explicit no-code-before-Ready gate.

**Step 3: Create the only product work branch**

Run:

~~~bash
git switch -c codex/v0.1-s04-ai-handoff-blackbox main
~~~

Expected: the branch starts from the documented baseline and the backup file remains untracked and untouched.

**Step 4: Commit the state handoff**

~~~bash
git add docs/NOW.md
git commit -m "docs: prepare S04 implementation state"
~~~

## Task 2: Add redaction and fact-level contracts

**Files:**
- Create: src/services/safe-redactor.js
- Create: test/safe-redactor.test.js

**Step 1: Write failing tests**

Cover:

- removal of API-key/token/password/private-key shaped values;
- removal of environment assignment values while retaining the variable name;
- replacement of sensitive output with a stable withheld_sensitive marker;
- preservation of ordinary Chinese/English task text and file paths;
- byte/character caps and deterministic output;
- fact-level constants: verified, user_confirmed, agent_reported, recorded_not_reverified, unknown.

Run:

~~~bash
node --test test/safe-redactor.test.js
~~~

Expected: FAIL because the module does not exist.

**Step 2: Implement the minimal redactor**

Export a pure redactText(value, options) and stable marker constants. Never log the input. Return metadata indicating whether content was withheld or truncated so callers can avoid persisting unsafe excerpts.

**Step 3: Run the focused test**

~~~bash
node --test test/safe-redactor.test.js
~~~

Expected: all redaction and fact-contract tests pass.

**Step 4: Commit**

~~~bash
git add src/services/safe-redactor.js test/safe-redactor.test.js
git commit -m "feat: add safe handoff redaction contract"
~~~

## Task 3: Implement the append-only local blackbox store

**Files:**
- Create: src/services/blackbox-store.js
- Create: test/blackbox-store.test.js
- Modify: .gitignore

**Step 1: Write failing tests**

Cover:

- creating blackbox.local/project_id/task_id.jsonl below an injected root;
- appending monotonically increasing seq values and ISO timestamps;
- rejecting duplicate task creation and history overwrite;
- preserving complete lines and ignoring a truncated final line during recovery;
- marking a task with no terminal event as interrupted during recovery;
- applying the redactor before writing event payloads;
- keeping the store independent from projects.local.json.

Run:

~~~bash
node --test test/blackbox-store.test.js
~~~

Expected: FAIL because the store does not exist.

**Step 2: Implement the store**

Expose createBlackboxStore({ rootDir, now, fsImpl }) with operations to begin a task, append an event, close a task, recover incomplete files, and read a task summary. Use explicit project/task identifiers, bounded JSON payloads, append-only writes, and no shell/process calls.

**Step 3: Protect generated local data**

Add only blackbox.local/ to .gitignore. Do not modify .token, tools.json, projects.local.json, or the backup asset.

**Step 4: Verify and commit**

~~~bash
node --test test/blackbox-store.test.js
git diff --check
git add .gitignore src/services/blackbox-store.js test/blackbox-store.test.js
git commit -m "feat: add append-only local blackbox store"
~~~

## Task 4: Build fresh project evidence snapshots

**Files:**
- Create: src/services/task-evidence.js
- Create: test/task-evidence.test.js
- Modify: src/services/git-inspector.js only if an additional read-only snapshot primitive is required
- Modify: test/git-inspector.test.js only for that primitive

**Step 1: Write failing snapshot tests**

Use temporary Git repositories and cover:

- before/after snapshots containing repo root, branch, HEAD, counts and bounded entries;
- classification of paths that were present before the task versus observed after it;
- explicit unknown classification when status output was truncated or causality cannot be proved;
- no Git write verbs, no raw stderr, and no full diff persisted;
- stale/missing active projects returning stable errors.

Run:

~~~bash
node --test test/task-evidence.test.js test/git-inspector.test.js
~~~

Expected: the new task evidence tests fail before the coordinator exists; existing Git Inspector tests remain green.

**Step 2: Implement snapshot and classification logic**

Inject projectBoundary and gitInspector. Resolve the active project afresh at each snapshot, call the existing read-only inspector, retain only the design-approved fields, and never claim that a concurrent change was caused by Pi.

**Step 3: Verify and commit**

~~~bash
node --test test/task-evidence.test.js test/git-inspector.test.js
git add src/services/task-evidence.js test/task-evidence.test.js
git add src/services/git-inspector.js test/git-inspector.test.js
git commit -m "feat: capture task Git evidence snapshots"
~~~

## Task 5: Integrate Pi lifecycle with evidence recording

**Files:**
- Modify: src/services/task-evidence.js
- Modify: src/services/pi-executor.js only for a narrowly scoped lifecycle hook if the coordinator cannot subscribe safely
- Modify: src/routes/execution.js
- Modify: src/server.js
- Modify: test/pi-executor.test.js
- Modify: test/execution-routes.test.js
- Create or modify: test/task-evidence.test.js

**Step 1: Write failing lifecycle tests**

Cover:

- task creation captures the active project and before snapshot before Pi starts;
- start/chunk/status/done events are appended with ordered sequence numbers;
- Pi auth, busy, spawn, timeout, stop and non-zero exit failures close the task with the correct status;
- client SSE disconnect does not stop Pi or stop evidence collection;
- an active task is recoverable after service restart as interrupted;
- task status never exposes raw event buffers or stderr through existing execution APIs.

Run:

~~~bash
node --test test/task-evidence.test.js test/pi-executor.test.js test/execution-routes.test.js
~~~

Expected: new coordinator assertions fail while the existing S03 behavior remains covered.

**Step 2: Implement the coordinator boundary**

Add a TaskEvidence coordinator that owns task state and subscribes to PiExecutor. It must delegate process control to the existing executor, keep the executor’s one-run invariant, append safe lifecycle events, obtain the after snapshot on terminal events, and expose a bounded evidence status. Do not move Pi spawning into a second service.

**Step 3: Wire the server and route dependencies**

In src/server.js, create one shared Git Inspector, Blackbox Store and Task Evidence instance. Pass the coordinator into execution/evidence routes, preserve the existing auth gate, and call its shutdown/recovery hook before the current process cleanup loop.

**Step 4: Verify and commit**

~~~bash
node --test test/task-evidence.test.js test/pi-executor.test.js test/execution-routes.test.js
git add src/services/task-evidence.js src/services/pi-executor.js src/routes/execution.js src/server.js
git add test/task-evidence.test.js test/pi-executor.test.js test/execution-routes.test.js
git commit -m "feat: record Pi task lifecycle evidence"
~~~

## Task 6: Add the safe validation command runner

**Files:**
- Create: src/services/validation-runner.js
- Create: test/validation-runner.test.js

**Step 1: Write failing runner tests**

Cover:

- exact executable plus argv runs with shell: false and the active project as cwd;
- shell operators, redirects, pipelines, command substitution, empty executables and environment assignments are rejected;
- user approval is required before execution;
- only one validation sequence runs at a time;
- timeout and output caps produce stable result codes without raw stderr leakage;
- exit code 0 maps to passed, non-zero to failed, cancellation to stopped;
- command output is redacted before it is returned or persisted.

Run:

~~~bash
node --test test/validation-runner.test.js
~~~

Expected: FAIL because the runner does not exist.

**Step 2: Implement the runner**

Export createValidationRunner({ spawnImpl, now, timeoutMs, outputLimit }). Accept only { executable, args, cwd, approvedByUser }, validate that cwd is the active repo root, spawn without a shell, capture exit metadata, and return safe excerpts/withheld markers rather than raw streams.

**Step 3: Verify and commit**

~~~bash
node --test test/validation-runner.test.js
git add src/services/validation-runner.js test/validation-runner.test.js
git commit -m "feat: add approved validation command runner"
~~~

## Task 7: Generate project AI handoff files atomically

**Files:**
- Create: src/services/ai-handoff.js
- Create: test/ai-handoff.test.js
- Modify: src/services/project-boundary.js
- Modify: src/routes/project.js
- Modify: test/project-boundary.test.js
- Modify: test/project-routes.test.js

**Step 1: Write failing handoff and enablement tests**

Cover:

- explicit per-project enablement persists in the v2 project state without breaking v1→v2 migration;
- enabling a project does not overwrite existing files;
- docs/ai-ops/NOW.md is created/updated atomically with the current schema;
- docs/ai-ops/records/task_id.md is written once and duplicate history is rejected;
- existing non-managed docs/ai-ops/NOW.md or AGENTS.md content is preserved and causes a safe conflict result;
- AGENTS.md receives only a bounded managed pointer after explicit enablement;
- facts, plan snapshot, changed paths, evidence statuses and the unique next action render deterministically;
- project files never contain sensitive values or raw stderr.

Run:

~~~bash
node --test test/ai-handoff.test.js test/project-boundary.test.js test/project-routes.test.js
~~~

Expected: new handoff tests fail before the writer and enablement contract exist; existing project migration tests remain green.

**Step 2: Implement the handoff writer**

Export createAiHandoff({ now, fsImpl, redactText }). Build the exact YAML-frontmatter/Markdown shape from verified facts, user confirmations, agent reports and unknowns. Use temporary files plus rename, refuse history overwrite, and never write before redaction succeeds.

**Step 3: Extend project enablement**

Add an optional handoff record to the project boundary state and a narrow authenticated route to enable/inspect it. Keep existing project payloads backward-compatible and whitelist new fields in the route response. Do not enable writing merely because a project is selected.

**Step 4: Verify and commit**

~~~bash
node --test test/ai-handoff.test.js test/project-boundary.test.js test/project-routes.test.js
git add src/services/ai-handoff.js src/services/project-boundary.js src/routes/project.js
git add test/ai-handoff.test.js test/project-boundary.test.js test/project-routes.test.js
git commit -m "feat: write safe project AI handoff records"
~~~

## Task 8: Close tasks through validation and handoff routes

**Files:**
- Create: src/routes/evidence.js
- Create: test/evidence-routes.test.js
- Modify: src/services/task-evidence.js
- Modify: src/server.js

**Step 1: Write failing route tests**

Cover authenticated, stable contracts for:

- current evidence status;
- validation command preview/approval and execution;
- explicit close with accepted, needs_review, or rejected;
- successful close requiring Git evidence and required validation results;
- close with not_run validation remaining non-accepted;
- failure/stop/interruption producing a record without exposing paths, task text, stderr or secrets;
- duplicate close being idempotent or safely rejected.

Run:

~~~bash
node --test test/evidence-routes.test.js
~~~

Expected: FAIL because the routes do not exist.

**Step 2: Implement the routes**

Keep all endpoints behind the existing /api auth gate. Return fixed safe messages and whitelisted payloads. The route must not accept a raw shell command; it accepts the structured executable/argv contract and delegates to TaskEvidence and ValidationRunner.

**Step 3: Wire and verify**

~~~bash
node --test test/evidence-routes.test.js test/execution-routes.test.js
git add src/routes/evidence.js src/services/task-evidence.js src/server.js test/evidence-routes.test.js
git commit -m "feat: expose task evidence and handoff close routes"
~~~

## Task 9: Add the project UI for handoff, timeline and evidence

**Files:**
- Modify: public/js/execution.js
- Modify: public/css/execution.css
- Modify: public/js/project.js
- Modify: public/css/project.css only if the enablement card needs shared project styling
- Modify: public/index.html only if a new mount or asset is required
- Modify: test/execution-ui.test.js
- Modify: test/project-ui.test.js

**Step 1: Write failing static UI assertions**

Cover:

- explicit enablement text and action before project writes are allowed;
- timeline/evidence/acceptance sections exist;
- validation command displays executable, args, cwd, approval and result;
- accepted/needs-review/stopped/interrupted states are distinguishable;
- all dynamic values use safe DOM APIs, never innerHTML or browser persistence;
- all requests use authenticated window.OPS.api and project/evidence endpoints only;
- existing risk-confirmation, SSE reader, focus preservation and folding behavior remain.

Run:

~~~bash
node --test test/execution-ui.test.js test/project-ui.test.js
~~~

Expected: FAIL on new S04 assertions before the UI is changed.

**Step 2: Implement the smallest UI flow**

Extend the existing project execution panel rather than creating a new page. Add:

- handoff enablement card with explicit write-risk explanation;
- current task timeline summary;
- before/after Git evidence summary;
- validation command confirmation and result display;
- close/acceptance actions and a link/path to the latest handoff record;
- safe error states for redaction conflict, stale project, missing evidence and interrupted task.

Do not persist UI state in localStorage, sessionStorage or IndexedDB.

**Step 3: Verify and commit**

~~~bash
node --test test/execution-ui.test.js test/project-ui.test.js
git add public/js/execution.js public/css/execution.css public/js/project.js public/css/project.css public/index.html
git add test/execution-ui.test.js test/project-ui.test.js
git commit -m "feat: show task timeline and handoff evidence"
~~~

## Task 10: Add full integration coverage and documentation

**Files:**
- Modify: test/execution-routes.test.js
- Modify: test/project-routes.test.js
- Modify: docs/NOW.md
- Modify: docs/PRODUCT.md
- Modify: docs/CODEMAP.md
- Modify: README.md only if the user-facing setup/verification flow requires a stable addition

**Step 1: Add an end-to-end temporary-project test**

Use only a temporary Git repository and fake Pi/validation binaries. Exercise:

~~~text
enable handoff
→ start task
→ stream Pi events
→ finish task
→ capture before/after Git facts
→ run approved validation
→ accept task
→ read NOW and historical record
~~~

Assert that existing pre-task modifications remain classified as pre-existing, no secret fixture appears in any generated file, and the next action is present.

**Step 2: Add negative and recovery coverage**

Cover auth rejection, no active project, stale project, busy run, validation timeout, validation non-zero, redaction failure, duplicate history, service restart recovery, and client disconnect.

Run:

~~~bash
npm test
~~~

Expected: all existing and new tests pass; the final count must be recorded from the actual output.

**Step 3: Update facts and evidence mapping**

In docs/NOW.md, record S04 acceptance-to-evidence mapping, fresh test count, user acceptance status and one next action. In docs/PRODUCT.md, update the S04 feature row and data boundary without changing v0.1 non-goals. In docs/CODEMAP.md, document stable modules, commands, generated blackbox.local/ boundary, project handoff paths and high-risk validation runner.

**Step 4: Run final verification**

~~~bash
git ls-files '*.js' | xargs -n1 node --check
git diff --check
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
~~~

Expected: syntax, whitespace and strict structural validation pass. These checks do not replace the user’s real acceptance.

**Step 5: Commit documentation and verification record**

~~~bash
git add docs/NOW.md docs/PRODUCT.md docs/CODEMAP.md README.md
git commit -m "docs: record S04 evidence and handoff verification"
~~~

## Task 11: Real user acceptance and finish gate

**Files:**
- No product-code changes unless a user-observed defect requires a scoped fix and a regression test.
- Update: docs/NOW.md with final evidence and the next slice.

**Step 1: Start an isolated local instance**

Run with an unused port and the current branch code. Do not print or inspect .token.

~~~bash
PORT=43211 npm start
~~~

**Step 2: Execute the acceptance matrix**

In a temporary test repository, verify:

- enablement explains exactly which project files will be written;
- existing project files and pre-existing Git changes are preserved;
- one Pi task streams and closes into a record;
- stop, busy, auth failure, timeout and disconnect states are visible;
- validation command requires explicit confirmation and records the real exit code;
- failed/not-run validation cannot be marked accepted;
- Codex/Pi can read docs/ai-ops/NOW.md and find the unique next action;
- no Key appears in chat, terminal, Git status, project records or logs;
- service restart leaves an interrupted record without an orphan process.

**Step 3: Capture user acceptance**

Record the user’s actual acceptance or rejection and any observed defects in docs/NOW.md; do not mark S04 done from automated tests alone.

**Step 4: Run the strict finish gate**

~~~bash
npm test
git ls-files '*.js' | xargs -n1 node --check
git diff --check
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
git status --short --branch
~~~

Expected: fresh evidence from the candidate commit, no unexpected tracked changes, and only explicitly preserved user assets remaining.

**Step 5: Stop for the user’s branch decision**

Present the candidate branch, commits, tests, real acceptance evidence, remaining risks and the proposed next slice S05. Do not merge, push or delete the work branch without explicit user direction.

## Verification matrix

| Design requirement | Automated evidence | Real/acceptance evidence |
|---|---|---|
| Local append-only blackbox | store/recovery/redaction tests | restart during a real task and inspect recovered state |
| Fresh Git before/after facts | temporary repositories and read-only command assertions | verify pre-existing changes remain untouched |
| Pi lifecycle timeline | fake Pi stream, stop, timeout, busy, disconnect tests | observe a real run and stop it |
| Validation command safety | argv-only, no-shell, timeout and redaction tests | approve a real project test command and inspect exit result |
| Project AI handoff files | atomic-write, conflict and no-secret tests | open with Codex/Pi and confirm unique next action is clear |
| Acceptance status | route/state-machine tests | confirm failed/not-run validation cannot be accepted |
| Existing product regression | full npm test, syntax, strict validation | escort, project, Pi, terminal and chat smoke checks |

## Rollback strategy

- Before any project write, require handoff enablement and preserve existing files.
- If handoff writing conflicts, leave the project untouched and keep the failure in the local blackbox.
- If validation runner or evidence routes fail, disable the new route/UI path while preserving S03 Pi execution.
- Revert only the S04 branch commits if the user chooses rollback; never use destructive workspace recovery and never remove projects.local.json.bak.
