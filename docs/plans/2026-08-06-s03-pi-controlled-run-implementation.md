---
type: implementation-plan
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S03-pi-controlled-run
status: completed
risk_level: high
branch: codex/v0.1-s03-pi-controlled-run
updated: 2026-08-12
design: ./2026-08-06-s03-pi-controlled-run-design.md
---

# S03 Pi Controlled Run Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user run Pi CLI inside the **active (ACTIVE) project** directory (S02b multi-project model) from the cockpit project view, with streaming output, a stop button, single-run enforcement, and no credential passing.

> **2026-08-12 amendments (D7–D10):** auth check is `pi auth check --provider <P> --json` (P = `PI_AUTH_PROVIDER` env > `PI_PROVIDER` env > `"google"`); boundary reads the S02b v2 `getStatus()` shape and uses `active`; baseline `0a2b44e`, existing tests 127; acceptance starts the server with `PI_AUTH_PROVIDER=aliyun-token-plan`; D10: spawn adds `--mode json` and the executor streams only assistant `text_delta` content (text mode buffers output until exit).

**Architecture:** Independent execution chain: `PiExecutor` (auth check + spawn with cwd=repoRoot + stream + stop + timeout + cleanup via activeProcs) → authenticated SSE routes → run panel inside the existing project view. No existing chain is modified beyond small assembly points.

> Completion record: user acceptance passed on 2026-08-13 after fixes for active-project derivation, JSON streaming, and run-panel layout. The slice was merged into `main`; current maintenance/UI regression verification is recorded in [NOW.md](../NOW.md).

**Tech Stack:** Node.js ESM, `node:child_process.spawn`, `activeProcs` registry, Node built-in test runner, Express 4, SSE (fetch + ReadableStream), native HTML/CSS/JS.

---

## Execution rules

- Work only on `codex/v0.1-s03-pi-controlled-run` (from recorded baseline `0a2b44e`).
- Follow the [S03 design](./2026-08-06-s03-pi-controlled-run-design.md). Any scope change stops work and goes back to design.
- **Tests never call the real `pi` binary.** All Pi interactions use fake shell-script binaries in `os.tmpdir()` (chmod 0o755), like the S02 git fixtures. No real API calls, no real credentials.
- Assert argv never contains `--api-key` and the task string is passed as a single argument.
- Pi subprocess must be registered in `activeProcs` (src/utils/process-registry.js) so server shutdown kills it; deregister on close.
- Error responses use the escort shape: `{ ok: false, code, message, action, retryable }`.
- Do not modify: `src/agent-caller.js`, `src/routes/api.js`, `public/js/chat.js`, `public/vendor/`, `agents.config.json`, `tools.json`, `package-lock.json`, terminal/launch/install routes, S01 escort files, S02 files (`src/services/git-inspector.js`, `src/services/project-boundary.js`, `src/routes/project.js`, `public/js/project.js`, `public/css/project.css`).
- One commit per task; commit only known slice files.

---

## Task 1: PiExecutor — controlled execution service

**Files:**
- Test: `test/pi-executor.test.js`
- Create: `src/services/pi-executor.js`

### Step 1.1: Write failing tests with fake pi binaries

Fake pi scripts are generated in `mkdtemp` dirs (chmod 0o755). Fixture factory variants:

```js
// success pi: answers auth check, echoes cwd + task, emits chunks, exits 0
const successScript = `#!/bin/sh
if [ "$1" = "auth" ]; then echo '{"ready":true}'; exit 0; fi
echo "CWD:$(pwd)"
echo "TASK:$2"
echo "chunk-1"
echo "chunk-2"
exit 0
`;
// slow pi: answers auth, then sleeps (for stop/timeout tests)
// authfail pi: auth check exits 1
// fail pi: exits 3 with stderr
// loud pi: outputs more than outputLimit
// argvdump pi: writes "$@" to $PWD/../argv-dump.txt
```

Fake boundary (S02b v2 shape): `{ async getStatus() { return { projects: [payload], activeProjectId: "abc123def456", active: { id: "abc123def456", repoRoot: <tmpdir>, stale: false, ... } } } }`. The fake pi script must answer the auth invocation `auth check --provider <P> --json` (emit `{"status":"ready",...}`) in addition to the `-p` run.

Test list:

1. `checkAuth()` happy path → `{ ready: true }`, argv contains `["auth", "check", "--provider", <P>, "--json"]`; authfail (`{"status":"not_ready"}`) → `{ ready: false }`; ENOENT binary → `{ ready: false, code: "pi_not_found" }`. Provider resolution: explicit option > `PI_AUTH_PROVIDER` env > `PI_PROVIDER` env > `"google"`.
2. `start("列出文件")` success → events `start`, `chunk`(multiple), `done` with `state: "exited"`, `exitCode: 0`; `getStatus()` reflects it.
3. argv audit: after run, dump file contains exactly `-p <task> --no-session --mode json` (D10); assert no `--api-key`; assert task with spaces/quotes is one argument.
4. cwd constraint: dump output contains `CWD:<repoRoot>` equal to boundary repoRoot.
5. stop: start slow pi, call `stop()` → `state: "stopped"`; process gone; `stop()` when idle → no-op (no throw).
6. timeout: `createPiExecutor({ timeoutMs: 300 })` with slow pi → final state `error`, `lastError.code === "timeout"`; process killed.
7. busy: `start` while running → rejects `busy`.
8. invalid task: `""` / 5000 chars / `"a\u0000b"` → rejects `invalid_task`.
9. no active project: boundary `{ projects: [], activeProjectId: null, active: null }` → rejects `no_project_selected`; stale active (`active.stale: true`) → rejects `project_stale`.
10. pi not found on start: piBinary `/nonexistent/pi` → rejects `pi_not_found`.
11. auth not ready on start → rejects `pi_not_authenticated`.
12. output truncation: loud pi with `outputLimit: 64` → `truncated: true`, output ≤ 64 bytes.
13. exit non-zero: fail pi → final state `error`, `exitCode: 3`; stderr never leaks into chunk events or error messages.
14. activeProcs registration: while running, proc ∈ `activeProcs`; after close, removed.
15. replay: subscriber attached after start receives buffered events (start + chunks so far) then live ones.

Run: `node --test test/pi-executor.test.js` — expected FAIL (module missing).

### Step 1.2: Implement `src/services/pi-executor.js`

```js
import { spawn } from "node:child_process";
import { activeProcs } from "../utils/process-registry.js";

export class PiExecutorError extends Error {
  constructor(code, { retryable = false } = {}) { super(code); this.name = "PiExecutorError"; this.code = code; this.retryable = retryable; }
}

export function createPiExecutor({
  projectBoundary,
  piBinary = "pi",
  authProvider = undefined, // D7: authProvider ?? env.PI_AUTH_PROVIDER ?? env.PI_PROVIDER ?? "google"
  timeoutMs = 600_000,
  outputLimit = 512 * 1024,
  killGraceMs = 3_000,
  now = () => Date.now(),
  spawnImpl = spawn,
} = {})
```

Behavior:

- Internal `run = null | { runId, task, proc, startedAt, output, truncated, exitCode, state, lastError, events: [] }`; `events` is the replay buffer for SSE.
- `emit(type, data)` appends to `run.events` and notifies live listeners (`subscribe(listener)` returns unsubscribe).
- `checkAuth()`: resolve provider P (D7 chain); `spawnImpl(piBinary, ["auth", "check", "--provider", P, "--json"], { shell: false })` with a 10s manual timeout; ENOENT → `{ ready: false, code: "pi_not_found" }`; exit 0 + JSON `status === "ready"` → `{ ready: true }`; else `{ ready: false, code: "pi_not_authenticated" }`; timeout → same with `retryable: true`. Never read credential values.
- `start(task)`:
  1. task validation → `invalid_task`
  2. `state === "running"` → `busy`
  3. `projectBoundary.getStatus()` (S02b v2) → `status.active` null → `no_project_selected`; `active.stale` → `project_stale`; cwd = `active.repoRoot`
  4. `checkAuth()` → `pi_not_found` / `pi_not_authenticated` (throw PiExecutorError with the code)
  5. `run = {...}`; `spawnImpl(piBinary, ["-p", task.trim(), "--no-session"], { cwd: active.repoRoot, env: process.env, stdio: ["ignore","pipe","pipe"], shell: false })`; `activeProcs.add(proc)`; emit `start`
  6. stdout data → append (cap `outputLimit`, set `truncated`, kill nothing — keep reading but stop buffering beyond cap); emit `chunk`
  7. stderr data → buffer capped 64KB internally only; never emit
  8. timeout timer → SIGTERM → killGrace → SIGKILL; state `error`, `lastError: { code: "timeout", retryable: true }`; emit `done`
  9. close → clear timers; `activeProcs.delete(proc)`; exitCode 0 → `exited`; stopping flag → `stopped`; else `error` with exitCode; emit `done { state, exitCode, truncated, durationMs }`; keep `run` for replay/status; set executor state
- `stop()`: no run or not running → return current status; set `stopping`; SIGTERM; after killGrace SIGKILL if alive.
- `getStatus()`: `{ state, runId, startedAt, exitCode, truncated, durationMs, output, task, lastError }`; when idle → `{ state: "idle", runId: null, ... }`.

### Step 1.3: Syntax + tests + commit

```bash
node --check src/services/pi-executor.js && node --test test/pi-executor.test.js
git add src/services/pi-executor.js test/pi-executor.test.js
git commit -m "feat: add controlled pi executor service"
```

---

## Task 2: Execution routes + server wiring

**Files:**
- Test: `test/execution-routes.test.js`
- Create: `src/routes/execution.js`
- Modify: `src/server.js` (imports + 1 construction + 1 mount)

### Step 2.1: Write failing route tests (FakeApp pattern; FakeResponse extended with `write()` recording)

1. Registers `GET /api/project/execution/status`, `POST /api/project/execution/start`, `POST /api/project/execution/stop`.
2. GET status → `{ ok: true, execution }` passthrough with whitelist (no `events` array in response).
3. POST start with missing/non-string task → 400 `invalid_task`, executor not called.
4. POST start error mapping (executor throws PiExecutorError): `no_project_selected` 400, `project_stale` 409, `pi_not_found` 424, `pi_not_authenticated` 424, `invalid_task` 400, `busy` 409, `spawn_failed` 502, `timeout` 504; unknown → 500 `internal_error`; body `{ ok:false, code, message, action, retryable }`.
5. POST start success → response headers `text/event-stream`; recorded writes contain `event: start` and `event: done` after executor emits; client `close` unsubscribes without stopping the executor.
6. POST stop → passthrough, returns `{ ok: true, execution }`.
7. Raw error text never leaks into JSON bodies.

Run: expected FAIL.

### Step 2.2: Implement `src/routes/execution.js`

Mirror `escort.js`/`project.js` route conventions: ERROR_INFO table (design §7.2 中文文案), SAFE_HTTP_STATUS, `sendError`, handlers with try/catch. Start handler: validate body → `await piExecutor.start(task)` (throws → sendError before SSE headers) → set SSE headers → write buffered + live events via `subscribe` → `res.on("close")` unsubscribe only.

### Step 2.3: Wire `src/server.js`

```js
import executionRoutes from "./routes/execution.js";
import { createPiExecutor } from "./services/pi-executor.js";
// near projectBoundary construction:
const piExecutor = createPiExecutor({ projectBoundary });
// after projectRoutes mount:
executionRoutes(app, { piExecutor });
```

### Step 2.4: Verify + commit

```bash
node --check src/routes/execution.js && node --check src/server.js
node --test test/execution-routes.test.js
npm test
git add src/routes/execution.js src/server.js test/execution-routes.test.js
git commit -m "feat: expose pi execution routes and wire server"
```

---

## Task 3: Run panel UI

**Files:**
- Create: `public/js/execution.js`, `public/css/execution.css`
- Modify: `public/index.html` (panel container + css/js includes), `public/js/project.js` (render the panel mount point when a project is selected)
- Test: `test/execution-ui.test.js`

### Step 3.1: Write failing static tests

1. index.html contains `execution-panel` mount point, `/css/execution.css`, `/js/execution.js`.
2. execution.js: no `innerHTML`/`insertAdjacentHTML`/`document.write`; uses `window.OPS.api`; contains risk-confirm flow (marker string `riskConfirmed`); uses `fetch` with `body.getReader()` + `TextDecoder` for SSE.
3. execution.js talks only to `/api/project/execution/*` endpoints.
4. execution.css non-empty, styles `#execution-panel`.

### Step 3.2: Implement UI

- `public/index.html`: in `project-view`, after `#project-wrap`, add `<div id="execution-panel"></div>`; add css/js includes.
- `public/js/project.js`: when rendering selected state, ensure `#execution-panel` stays in DOM (it is static in HTML; execution.js self-initializes and polls status). Minimal change: no coupling needed if execution.js self-init reads `/api/project/execution/status` on load and re-renders on its own timer/events. Decision: execution.js fully self-contained (IIFE, self-init, own refresh button + auto status fetch on load); project.js untouched. **Amendment: 9.2 drops project.js modification; index.html provides the static container.**
- `public/js/execution.js`: IIFE; states: no project (hint), auth-not-ready (guidance), idle (risk warning + textarea 4000 max + start button), running (status light, output pre-area via textContent, stop button, elapsed), finished (exit state + code + restart entry); SSE via `fetch` + `response.body.getReader()` + `TextDecoder`, parse `event:`/`data:` pairs like chat.js; risk confirmation = first click arms, second click starts (or explicit confirm checkbox); all dynamic text via textContent.
- `public/css/execution.css`: follow escort/project css variables.

### Step 3.3: Verify + commit

```bash
node --check public/js/execution.js
node --test test/execution-ui.test.js && npm test
git add public/js/execution.js public/css/execution.css public/index.html test/execution-ui.test.js
git commit -m "feat: add pi run panel to project view"
```

---

## Task 4: Full automated verification

1. `git ls-files '*.js' | xargs -n1 node --check` — pass.
2. `npm test` — existing 127 + new pass; record count.
3. `git diff --check $(git merge-base main HEAD)..HEAD` — clean.
4. Protected-paths audit: `git diff --name-only main...HEAD` contains no forbidden path.
5. Isolated port `PORT=43213 npm start`: `/api/health` ok; `/api/project/execution/status` without token → 401; stop instance.
6. `validate-project-state.mjs . --strict` — PASS.
7. Record all outputs in NOW.md 验证证据.

---

## Task 5: Real acceptance, boundary proof, handoff

With the user (test repo `/tmp/s03-acceptance`, git init + 1 commit). Server started with `PI_AUTH_PROVIDER=aliyun-token-plan PORT=3210 npm start` (D7):

1. Register the test repo in project view and **set it as the active project**; snapshot `find /tmp/s03-acceptance -type f` before.
2. Start minimal task（如「列出当前目录的文件」）after risk confirm; verify streaming output, cwd correctness (output shows the test repo), status light.
3. Stop a second run mid-execution; verify state stopped, process gone (`pgrep -f "pi -p"` empty after stop).
4. After runs: `find /tmp/s03-acceptance -type f` diff = only Pi-expected artifacts (zero unexpected writes outside repo: check `$HOME` untouched via mtime spot-check is out of scope; rely on cwd constraint + user observation).
5. Verify: no active project → start rejected; running → second start rejected (busy).
6. Write results into NOW.md; mark slice per outcome; merge only after user acceptance, same ceremony as S01/S02.

**Done gate:** user personally completes scenarios and confirms; AI claims do not count.
