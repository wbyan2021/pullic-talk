# S05-B Safe Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users preview and restart failed or interrupted Pi tasks in the same active Git project without restoring files, resuming old processes, or exposing sensitive task data.

**Architecture:** Add a `task-recovery` orchestration service over the existing `blackbox-store`, `task-evidence`, `project-boundary`, `pi-executor`, and `ai-handoff` services. The service creates a short-lived, one-time preview and rechecks a project/task fingerprint before calling a new-task entry point in `task-evidence`; the original record is append-only and the new task records its source task. Add authenticated recovery routes, a read-only overview summary, and preview/confirm controls in the existing Project execution panel.

**Tech Stack:** Node.js ESM, Express 4, native `node:test`, existing blackbox JSONL, plain HTML/CSS/JavaScript, existing authenticated API and Pi executor.

---

## Scope and protected boundaries

- Continue on `codex/v0.1-s05-overview-readonly`, based on accepted design commit `68d6d2d` and current docs commit `a3f664f`.
- Risk is `high`: process control, project boundaries, append-only evidence, and potential user-data exposure.
- Only `failed` and `interrupted` source tasks are eligible. `stopped`, successful `exited`, and `accepted` tasks are not eligible.
- Recovery starts a new Pi run in the current active project. Never pass a browser-supplied path, command, or raw task override to the service.
- Do not execute Git write commands, restore files, delete files, auto-commit, merge, push, resume an old process, or add multi-task execution.
- Do not read or expose `.token`, real `.env`, `~/.secrets.env`, Keychain values, raw stderr, raw output, full command arguments, cwd, or full changed-path arrays.
- Preserve all existing Project, Pi execution, Evidence, Escort, Chat, Terminal, Installer, and Overview behavior outside this slice.

### Task 1: Lock the recovery data contract with failing tests

**Files:**
- Create: `test/task-recovery.test.js`
- Modify: `test/blackbox-store.test.js`
- Modify: `test/task-evidence.test.js`

**Step 1: Write failing service-contract tests**

Cover:

- `failed` and `interrupted` tasks are eligible;
- `stopped`, successful `exited`, `accepted`, missing, malformed, and cross-project tasks are rejected;
- preview returns only safe fields and a bounded one-time handle;
- changed project fingerprint, busy executor, expired/consumed handle, and missing payload reject confirmation;
- new task receives `sourceTaskId` metadata while the source record remains append-only;
- no service result contains original task text, output, stderr, args, cwd, or full path arrays.

Run: `node --test test/task-recovery.test.js test/blackbox-store.test.js test/task-evidence.test.js`

Expected: FAIL because no recovery service or recovery-aware task start exists.

**Step 2: Add the minimal test fixtures**

- Build temporary project IDs and JSONL events with only fake task text and safe status codes.
- Use fake project boundary, Git inspector, task evidence, handoff reader, and executor dependencies.
- Assert source JSONL bytes/events are not overwritten and no real project path is read.

Run: `node --test test/task-recovery.test.js`

Expected: FAIL only on missing implementation symbols/behavior.

**Step 3: Commit the contract tests**

```bash
git add test/task-recovery.test.js test/blackbox-store.test.js test/task-evidence.test.js
git commit -m "test: define safe recovery contract"
```

### Task 2: Implement recovery orchestration and new-task linkage

**Files:**
- Create: `src/services/task-recovery.js`
- Modify: `src/services/task-evidence.js`
- Modify: `src/services/blackbox-store.js`
- Test: `test/task-recovery.test.js`

**Step 1: Add explicit recovery errors and safe projections**

Implement stable error codes from the design: `recovery_not_eligible`, `recovery_task_not_found`, `recovery_payload_unavailable`, `recovery_project_stale`, `recovery_busy`, `recovery_preview_expired`, `recovery_confirmation_required`, `recovery_start_failed`, and `recovery_internal_error`. Keep raw internal errors out of messages and JSON.

Run: `node --test test/task-recovery.test.js`

Expected: FAIL only on missing orchestration behavior.

**Step 2: Implement source-task inspection**

- Read a single source task through `blackboxStore.readTask({ projectId, taskId })`.
- Derive the terminal state from trusted terminal events and read the already-redacted task payload from `task_created` only for server-side replay.
- Reject missing, malformed, non-terminal, `stopped`, successful, and accepted sources.
- Confirm the source project equals the current active project and is not stale.

Run: `node --test test/task-recovery.test.js`

Expected: eligibility tests PASS.

**Step 3: Implement preview handles and fingerprint checks**

- Generate an in-memory preview record with a random opaque ID and bounded expiry.
- Bind it to source task ID, source project ID, terminal event sequence, active project ID, branch, HEAD, and change counts.
- Return only the preview contract from the service; never return the source task or event list.
- Re-read all bound facts at confirmation and consume the handle exactly once.

Run: `node --test test/task-recovery.test.js`

Expected: preview, expiry, mutation, and double-submit tests PASS.

**Step 4: Link a new task without changing old history**

- Extend `taskEvidence.start(rawTask, { recoveryOfTaskId, recoveryReasonCode })` or an equivalent explicit method while preserving normal start callers.
- Pass the source linkage into `task_created` and append a safe `recovery_started` event to the new record.
- Keep the source record append-only; if a source audit event is needed, append a bounded recovery event without rewriting existing lines.
- Call the existing Pi start path only after all preflight checks and the single-execution lock succeed.

Run: `node --test test/task-recovery.test.js test/s04-integration.test.js`

Expected: recovery integration and existing S04 tests PASS.

**Step 5: Commit the service implementation**

```bash
git add src/services/task-recovery.js src/services/task-evidence.js src/services/blackbox-store.js test/task-recovery.test.js
git commit -m "feat: add safe task recovery service"
```

### Task 3: Expose authenticated recovery routes and overview summary

**Files:**
- Create: `src/routes/recovery.js`
- Modify: `src/routes/overview.js`
- Modify: `src/server.js`
- Test: `test/recovery-routes.test.js`
- Modify: `test/overview-routes.test.js`

**Step 1: Write failing route tests**

Cover:

- route registration after the existing `/api` authentication gate;
- status projection for an eligible task and safe empty state;
- preview requires a valid task ID and returns a safe bounded contract;
- start requires the preview ID and `confirmed: true`;
- unknown errors map to fixed safe messages;
- responses omit task, output, stderr, args, cwd, original task text, raw paths, and internal error strings.

Run: `node --test test/recovery-routes.test.js test/overview-routes.test.js`

Expected: FAIL because route registration and recovery projection do not exist.

**Step 2: Implement route field whitelists and errors**

- Add `GET /api/recovery/status`, `GET /api/recovery/:taskId/preview`, and `POST /api/recovery/:taskId/start`.
- Validate task ID format and confirmation/preview fields before calling the service.
- Use fixed Chinese-primary bilingual-safe error payloads with stable codes and retryability.
- Mount routes after `app.use("/api", authGate)` and inject the single recovery service instance.

Run: `node --test test/recovery-routes.test.js`

Expected: route tests PASS.

**Step 3: Add read-only recovery projection to Overview**

- Add `overview.evidence.recovery` with `available`, `sourceTaskId`, `sourceState`, `reasonCode`, and normalized state only.
- Keep Overview read-only: it may navigate to the Project recovery panel but never calls preview/start mutation endpoints.
- Preserve the existing sensitive-field omission contract.

Run: `node --test test/overview-routes.test.js`

Expected: overview projection tests PASS.

**Step 4: Commit route wiring**

```bash
git add src/routes/recovery.js src/routes/overview.js src/server.js test/recovery-routes.test.js test/overview-routes.test.js
git commit -m "feat: expose safe recovery routes"
```

### Task 4: Add Project recovery preview and confirmation UI

**Files:**
- Modify: `public/js/execution.js`
- Modify: `public/css/execution.css`
- Modify: `public/js/overview.js`
- Modify: `public/css/overview.css`
- Test: `test/execution-ui.test.js`
- Modify: `test/overview-ui.test.js`

**Step 1: Write failing UI contract tests**

Assert:

- Overview renders a bilingual recoverable summary and only navigates to Project;
- execution UI calls recovery status/preview/start only through the authenticated API helper;
- preview and confirm controls require explicit confirmation and never inject API data with `innerHTML`;
- stopped, accepted, successful, busy, stale, expired, and unavailable states render safe explanations;
- no browser persistence, EventSource, raw task/output/args/cwd, or automatic file rollback command appears in the UI code.

Run: `node --test test/execution-ui.test.js test/overview-ui.test.js`

Expected: FAIL because recovery controls and mappings do not exist.

**Step 2: Render the Overview recovery summary**

- Add Chinese-primary labels for `可恢复 / Recoverable`, `不可恢复 / Not Recoverable`, `预览已过期 / Preview Expired`, and `已有任务运行 / Busy`.
- Keep the button as a navigation action to the Project view; do not start a task from Overview.

Run: `node --test test/overview-ui.test.js`

Expected: overview UI tests PASS.

**Step 3: Implement Project preview/confirm flow**

- Add in-memory UI state for preview, confirmation, busy, expiry, and safe error text.
- Request a preview only when a terminal failed/interrupted evidence state is present.
- Display source status, safe reason, project/branch/HEAD, change count, expiry, and the explicit “不会回退文件 / Files will not be rolled back” warning.
- Require a second click/confirmation before POST start; clear the preview handle on cancellation, start, expiry, or project change.
- On success, refresh execution/evidence and show the source task linkage from the server; do not reconstruct it in the browser.

Run: `node --test test/execution-ui.test.js`

Expected: execution UI tests PASS.

**Step 4: Commit the UI**

```bash
git add public/js/execution.js public/css/execution.css public/js/overview.js public/css/overview.css test/execution-ui.test.js test/overview-ui.test.js
git commit -m "feat: add safe recovery preview controls"
```

### Task 5: Add high-risk integration, security, and failure-path coverage

**Files:**
- Modify: `test/s04-integration.test.js`
- Modify: `test/task-recovery.test.js`
- Modify: `test/recovery-routes.test.js`

**Step 1: Add end-to-end recovery scenarios**

Cover a failed task and a service-restart interrupted task through preview, confirm, new Pi run, terminal evidence, and source linkage. Use temporary Git repositories and fake Pi processes; never use a real Key or personal project data.

Run: `node --test test/s04-integration.test.js test/task-recovery.test.js test/recovery-routes.test.js`

Expected: all recovery scenarios PASS; no Git write operation is invoked.

**Step 2: Add adversarial safety assertions**

- Inject fake secrets and raw stderr into dependency results and assert they never appear in route payloads, events, or UI source.
- Attempt cross-project task IDs, stale fingerprints, consumed handles, duplicate starts, invalid IDs, shell-like strings, and browser-supplied path overrides.
- Assert original JSONL history remains parseable and existing lines are unchanged.

Run: `node --test test/task-recovery.test.js test/recovery-routes.test.js test/overview-routes.test.js`

Expected: all security assertions PASS.

**Step 3: Commit integration coverage**

```bash
git add test/s04-integration.test.js test/task-recovery.test.js test/recovery-routes.test.js
git commit -m "test: verify recovery failure and security paths"
```

### Task 6: Fresh verification, documentation, and handoff

**Files:**
- Modify: `docs/NOW.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/CODEMAP.md`
- Modify: `docs/ai-ops/NOW.md`

**Step 1: Run focused verification**

```bash
node --test test/task-recovery.test.js test/recovery-routes.test.js test/overview-routes.test.js test/execution-ui.test.js test/overview-ui.test.js
git ls-files '*.js' | xargs -n1 node --check
git diff --check
```

Expected: all focused tests pass; syntax and diff checks are clean.

**Step 2: Run the full regression and strict validation**

```bash
node --test
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
```

Expected: all tests pass, strict validation passes, and no private/generated file is staged.

**Step 3: Perform manual acceptance on an isolated port**

- Start `PORT=43211 PI_AUTH_PROVIDER=aliyun-token-plan npm start`.
- Create a safe temporary Git task that fails or interrupt it via service restart.
- Confirm the recovery card, preview contents, explicit no-rollback warning, new task ID, source linkage, old history, and blocked states.
- Confirm `/api/health` is HTTP 200 and unauthorized recovery requests are rejected without a token.
- Do not enter or display any Key, token, password, private key, or personal data.

**Step 4: Update facts and commit documentation**

- Record actual focused/full test counts, manual observations, changed paths, residual risks, and the user acceptance status.
- Keep S05-A Overview acceptance separate from S05-B recovery acceptance.
- Do not mark S05-B done until the user confirms the manual recovery flow.

```bash
git add docs/NOW.md docs/PRODUCT.md docs/CODEMAP.md docs/ai-ops/NOW.md
git commit -m "docs: record s05b recovery verification"
```

## Rollback

Before user acceptance, revert only the S05-B commits in reverse order or remove the recovery route/UI changes while preserving the prior S05-A commits and all user-owned files. Never use `git reset --hard`, `git clean`, force-push, or overwrite `projects.local.json.bak`.

## Definition of Done

- Every acceptance item in the S05-B design maps to a fresh test or manual observation.
- Failed and interrupted tasks recover through a new Pi batch in the same active project.
- Stopped, successful, accepted, stale, busy, malformed, and missing-source cases are blocked safely.
- Preview state is rechecked and single-use; source history is append-only and linked.
- No project file rollback or Git write command is reachable from the feature.
- No task text, output, stderr, args, cwd, full paths, or credentials leak to browser/API/logs.
- Full tests, syntax, diff, strict validation, and isolated-port health checks pass.
- User completes manual acceptance before S05-B is marked done or merged.
