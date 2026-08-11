---
type: implementation-plan
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S02-git-safety-boundary
status: active
risk_level: medium
branch: codex/v0.1-s02-git-safety-boundary
updated: 2026-08-06
design: ./2026-08-06-s02-git-safety-boundary-design.md
---

# S02 Git Safety Boundary Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let the user select one local Git project in the cockpit; the system read-only inspects the workspace (branch, dirty files, last commit, remotes), persists the selection server-side, and never writes to the target repository.

**Architecture:** New isolated chain mirroring S01: `GitInspector` (read-only git subprocess adapter with a command whitelist) → `ProjectBoundaryService` (selection state machine + `projects.local.json` persistence) → authenticated Express routes → a new "项目" view on the existing home page. No existing chain is modified beyond three small assembly points.

**Tech Stack:** Node.js ESM, `node:child_process.spawnFile`, Node built-in test runner, Express 4, native HTML/CSS/JavaScript, `/usr/bin/git`.

---

## Execution rules

- Work only on `codex/v0.1-s02-git-safety-boundary` (from recorded baseline `40c5e48`).
- Follow the [S02 design](./2026-08-06-s02-git-safety-boundary-design.md). Any scope change stops work and goes back to design.
- **Zero write to any real repository.** Tests create fixture repos only inside `os.tmpdir()` with explicit `-c user.name=... -c user.email=... -c init.defaultBranch=main`; never use this repository or any user repo as a fixture.
- Do not read `.token` or any real credential. `projects.local.json` never contains secrets and must stay out of Git.
- Do not modify: `src/agent-caller.js`, `src/routes/api.js`, `public/js/chat.js`, `public/vendor/`, `agents.config.json`, `tools.json`, `package-lock.json`, and every S01 escort file (`src/providers/`, `src/services/credential-store.js`, `src/services/escort-service.js`, `src/routes/escort.js`, `public/js/escort.js`, `public/css/escort.css`, `test/escort-*.test.js`, `test/credential-store.test.js`, `test/deepseek-provider.test.js`).
- `.gitignore`: append `projects.local.json`. The file already carries the user's unstaged `.superpowers/` line — **ask the user before staging `.gitignore`** (commit both lines together, or leave both unstaged). Default if unreachable: leave unstaged and record in NOW.md.
- Error responses use the escort shape: `{ ok: false, code, message, action, retryable }`.
- One commit per task; commit only known slice files; leave unrelated user changes unstaged.

---

## Task 1: Git Inspector — read-only adapter

**Files:**
- Test: `test/git-inspector.test.js`
- Create: `src/services/git-inspector.js`

### Step 1.1: Write the fixture helper and failing tests

Create `test/git-inspector.test.js`. Fixture helper (all fixtures in `fs.mkdtempSync(join(os.tmpdir(), "s02-git-"))`, removed in `t.after`):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnFileSync } from "node:child_process";
import { createGitInspector, GitInspectorError, READ_ONLY_VERBS } from "../src/services/git-inspector.js";

const GIT_OPTS = ["-c", "user.name=s02-test", "-c", "user.email=s02@test.local"];

function git(cwd, ...args) {
  const r = spawnFileSync("git", [...GIT_OPTS, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(t, { commits = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "s02-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(dir, `file-${i}.txt`), `v${i}\n`);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", `commit ${i}`);
  }
  return dir;
}
```

Test list (each `assert.rejects` checks `error.code`):

1. clean repo → `branch: "main"`, `detached: false`, `hasCommits: true`, all counts 0, `entries: []`, `remotes: []`, `repoRoot` equals realpath, `headCommit.hash` length ≥ 7 and `headCommit.subject` contains "commit 1".
2. dirty repo (staged new file via `git add`; unstaged modification; untracked file) → `counts.staged === 1`, `counts.unstaged === 1`, `counts.untracked === 1`, entries carry matching 2-char status codes and paths.
3. conflicted repo (branch `other`, divergent edits to same file, `git merge other` expected to exit 1) → `counts.conflicted === 1`, entry status `UU`.
4. detached (`git checkout -q --detach`) → `detached: true`, `branch: null`, `hasCommits: true`.
5. unborn repo (`git init` only) → `hasCommits: false`, `branch: "main"`, `headCommit: null`, counts all 0.
6. remote (`git remote add origin https://example.invalid/x.git`) → `remotes: ["origin"]`.
7. non-repo directory → rejects `not_a_git_repo`.
8. missing binary (`createGitInspector({ gitBinary: "/nonexistent/git" })`) → rejects `git_unavailable`.
9. timeout (`gitBinary: "/bin/sleep"` with `["3"]`-equivalent invocation via `timeoutMs: 150`) → rejects `git_timeout`. Implement by injecting `timeoutMs` and pointing gitBinary at a shell-free sleeping binary (`/bin/sleep` with arg `3` passed as the git argv — inspector always passes subcommand args, so sleep receives them and still sleeps).
10. entry truncation (`createGitInspector({ entryLimit: 2 })`, 4 untracked files) → `entries.length === 2`, `truncated: true`.
11. path safety: empty / 2000-char / NUL paths → `invalid_path`; nonexistent → `path_not_found`; a file → `not_a_directory`; `homedir()` itself → `forbidden_root`; symlinked repo dir resolves (`resolvedPath` equals realpath, differs from input).
12. read-only verb guard: `READ_ONLY_VERBS` ⊆ `{rev-parse, symbolic-ref, log, status, remote}`; internal runner rejects any other first argument with `git_failed` (export a `runGitForTest` or construct a spy to assert).

Run: `node --test test/git-inspector.test.js` — expected: FAIL (module not found).

### Step 1.2: Implement `src/services/git-inspector.js`

Contract:

```js
export class GitInspectorError extends Error {
  constructor(code, { retryable = false } = {}) { super(code); this.code = code; this.retryable = retryable; }
}
export const READ_ONLY_VERBS = Object.freeze(["rev-parse", "symbolic-ref", "log", "status", "remote"]);

export function createGitInspector({
  gitBinary = "/usr/bin/git",
  timeoutMs = 10_000,
  statusBytesLimit = 512 * 1024,
  entryLimit = 200,
  subjectLimit = 200,
} = {}) { return { resolveTarget, inspect }; }
```

Implementation rules:

- `runGit(args, cwd)`: assert `READ_ONLY_VERBS.includes(args[0])`; `spawnFile(gitBinary, args, { cwd, shell: false, env: process.env })`; ENOENT → `git_unavailable`; manual setTimeout → kill + `git_timeout` (retryable); for `status`, accumulate stdout and kill with a `limitTruncated` flag once `statusBytesLimit` exceeded (do not map that kill to an error); non-zero exit → `git_failed` (retryable) except where callers expect benign non-zero (`symbolic-ref` detached, `rev-parse --verify` unborn); never include stderr text in thrown messages.
- `resolveTarget(inputPath)`: trim; reject empty / >1024 chars / NUL → `invalid_path`; `fs.realpath` (ENOENT → `path_not_found`); `fs.stat` must be directory → `not_a_directory`; reject `/` or `realpath(homedir())` → `forbidden_root`.
- `inspect(inputPath)`: resolveTarget → `rev-parse --is-inside-work-tree` (expect `true`, else `not_a_git_repo`) → `rev-parse --show-toplevel` → `symbolic-ref --short -q HEAD` (fail → detached-or-unborn) → `rev-parse --verify --short HEAD` (fail → unborn) → `log -1 --format=%h%x09%cs%x09%s` (split on `\t`, truncate subject) → `status --porcelain=v1` parse → `remote`.
- porcelain parse: per line, `XY = line.slice(0,2)`, `path = line.slice(3)`; `??` → untracked; `U` in XY or `AA`/`DD` → conflicted; else X≠' ' → staged, Y≠' ' → unstaged; cap `entries` at `entryLimit`, set `truncated` when capped or byte-limit killed.
- Return `{ inputPath, resolvedPath, repoRoot, branch, detached, hasCommits, headCommit, counts, entries, truncated, remotes, inspectedAt }` (inspector does not set `inspectedAt`; service stamps it — or set it here via injected `now`; choose injected `now` defaulting to `Date`).

Run: `node --test test/git-inspector.test.js` — expected: all PASS.

### Step 1.3: Syntax + commit

```bash
node --check src/services/git-inspector.js && node --check test/git-inspector.test.js
git add src/services/git-inspector.js test/git-inspector.test.js
git commit -m "feat: add read-only git inspector adapter"
```

---

## Task 2: Project Boundary Service — state machine + persistence

**Files:**
- Test: `test/project-boundary.test.js`
- Create: `src/services/project-boundary.js`

### Step 2.1: Write failing tests

Reuse the Task 1 fixture pattern (temp repos; statePath = `join(mkdtemp…, "projects.local.json")`). Tests:

1. `getStatus()` before any select → `{ selected: false }`.
2. `select(validRepo)` → payload `{ selected: true, inputPath, resolvedPath, repoRoot, selectedAt, stale: false, inspection: {...}, selectionSnapshotAt }`; state file exists; JSON parses; `version === 1`.
3. select persists last inspection; a second `select(otherRepo)` replaces the record entirely.
4. select error passthrough: non-repo → rejects `not_a_git_repo`; missing path → `path_not_found` (and no file written on failure).
5. `refresh()` with no selection → `no_project_selected`.
6. `refresh()` healthy → updates `inspection.inspectedAt`, keeps `selectedAt`, rewrites file.
7. stale: select temp repo, `rmSync(repo)`, then `getStatus()` → `stale: true`; `refresh()` → rejects `project_stale`; `clear()` still works.
8. `clear()` → `{ selected: false }`, file removed; second `clear()` → same result, no throw (idempotent).
9. corrupted state file (`writeFileSync(statePath, "{bad json")`) → new service `getStatus()` → `{ selected: false }` (no throw).
10. persistence across instances: select, create second service with same statePath → `getStatus()` returns the same selection.
11. payload never contains secrets: assert payload keys are exactly the whitelist `{ selected, inputPath, resolvedPath, repoRoot, selectedAt, stale, inspection, selectionSnapshotAt }`; `inspection` keys exactly `{ inspectedAt, branch, detached, hasCommits, headCommit, counts, entries, truncated, remotes }`.

Run: `node --test test/project-boundary.test.js` — expected: FAIL.

### Step 2.2: Implement `src/services/project-boundary.js`

```js
export class ProjectBoundaryError extends Error { /* same shape as GitInspectorError */ }
export function createProjectBoundary({ inspector, statePath, now = () => Date.now() }) {
  return { getStatus, select, refresh, clear };
}
```

- Internal `record` cached in memory; lazy `ensureLoaded()` reads `statePath` once (missing → none; unreadable/corrupt → none + one-line console.warn without path contents beyond fixed text).
- `select(inputPath)`: `inspector.inspect` → build record `{ inputPath, resolvedPath, repoRoot, selectedAt: iso, selectionSnapshot: deepCopy(inspection), lastInspection: inspection }` → atomic write (tmp file in same dir + `rename`) → return payload.
- `refresh()`: no record → `no_project_selected`; verify `repoRoot` still dir + still repo via inspector (`rev-parse` via `inspect(repoRoot)`; if it throws `not_a_git_repo`/`path_not_found` → mark `stale: true`, persist, throw `project_stale`); else update `lastInspection`, persist, return payload.
- `getStatus()`: no record → `{ selected: false }`; else check path validity cheaply (`fs.stat` dir) → `stale` flag; return payload built from `lastInspection` (no `selectionSnapshot` contents in payload, only `selectionSnapshotAt`).
- `clear()`: record = null; delete file if exists (ignore ENOENT); return `{ selected: false }`.

Run: `node --test test/project-boundary.test.js` — expected: all PASS.

### Step 2.3: Syntax + commit

```bash
node --check src/services/project-boundary.js && node --check test/project-boundary.test.js
git add src/services/project-boundary.js test/project-boundary.test.js
git commit -m "feat: add project boundary service with local persistence"
```

---

## Task 3: Authenticated routes + server wiring

**Files:**
- Test: `test/project-routes.test.js`
- Create: `src/routes/project.js`
- Modify: `src/server.js` (imports + 2 construction lines + 1 mount line, following the escort pattern)
- Modify: `.gitignore` (append `projects.local.json`; **do not stage yet** — user decision, see execution rules)

### Step 3.1: Write failing route tests (FakeApp pattern from `test/escort-routes.test.js`)

Fake service with call recording. Tests:

1. `GET /api/project/status` → 200 passthrough of service payload.
2. `POST /api/project/select` with `{ json: { path } }` → 200; missing/non-string `path` → 400 `invalid_path` without calling service.
3. `POST /api/project/refresh`, `POST /api/project/clear` → passthrough; clear returns `{ selected: false }`.
4. Error mapping table (service throws `ProjectBoundaryError`/`GitInspectorError` with code): `invalid_path|path_not_found|not_a_directory|forbidden_root|not_a_git_repo|no_project_selected` → 400; `project_stale` → 409; `git_unavailable` → 424; `git_timeout` → 504; `git_failed` → 502. Body always `{ ok: false, code, message, action, retryable }` with fixed Chinese message from an in-file table; assert no raw error text passes through.
5. Unknown error / unknown code → 500 `{ ok: false, code: "internal_error", ... }`, message fixed, no leak.
6. Field whitelist: service returns extra key `__secret` → response payload does not contain it.

Run: `node --test test/project-routes.test.js` — expected: FAIL.

### Step 3.2: Implement `src/routes/project.js`

Mirror `src/routes/escort.js` structure: `ERROR_INFO` table (code → `[message, action, retryable]`, texts from design §8.1), `SAFE_HTTP_STATUS` table, `sendError(res, error)` with unknown-error fallback, four handlers with try/catch, body limit already global (2 mb). Select handler: `typeof body?.path === "string"` else 400 `invalid_path`.

### Step 3.3: Wire `src/server.js`

Add imports and (next to the escort service construction):

```js
const projectBoundary = createProjectBoundary({
  inspector: createGitInspector(),
  statePath: join(ROOT, "projects.local.json"),
});
// mount after authGate, alongside escortRoutes:
projectRoutes(app, { projectBoundary });
```

Append `projects.local.json` to `.gitignore` (leave unstaged with the user's `.superpowers/` line until the user decides).

### Step 3.4: Verify + commit

```bash
node --check src/routes/project.js && node --check src/server.js
node --test test/project-routes.test.js   # all PASS
npm test                                   # all suites PASS
git add src/routes/project.js src/server.js test/project-routes.test.js
git commit -m "feat: expose project boundary routes and wire server"
```

---

## Task 4: Project view UI

**Files:**
- Create: `public/js/project.js`, `public/css/project.css`
- Modify: `public/index.html` (tab + view + css/js includes), `public/js/index.js` (one visibility line in `switchView`)
- Test: `test/project-ui.test.js`

### Step 4.1: Write failing static tests

`test/project-ui.test.js` reads files as text:

1. `index.html` contains: tab button `data-view="project"`, `<div class="view" id="project-view">`, `<link rel="stylesheet" href="/css/project.css">`, `<script src="/js/project.js"></script>`.
2. `index.js` `switchView` toggles `#project-view`.
3. `project.js`: contains zero occurrences of `innerHTML`; uses `window.OPS.api`; contains a confirm-before-clear flow (two-step button state or inline confirm marker); no `localStorage`/`sessionStorage`/`indexedDB` usage.
4. `project.css` exists and defines `.view#project-view`-relevant styles (non-empty, contains at least the wrap id selector).

Run: `node --test test/project-ui.test.js` — expected: FAIL.

### Step 4.2: Implement UI

`public/index.html`:
- subbar tabs (after 群聊): `<button class="tab" data-view="project" onclick="switchView('project')"><span class="g">⌂</span> 项目</button>`
- after `chat-view` div: `<div class="view" id="project-view"><div id="project-wrap"></div></div>`
- head: project.css link; scripts block: project.js after escort.js.

`public/js/index.js` in `switchView`: `$("#project-view").classList.toggle("active", v==="project");`

`public/js/project.js`: IIFE like escort.js; `window.OPS.api` requests to the four endpoints; states: loading / empty (path input + 选择并识别 + scope explanation text) / selected (repo root incl. resolved path when different, branch or detached/unborn badge, head commit line, counts grid, entries list in `<pre>`-like mono built via `textContent`, remotes, boundary note 「该仓库根将作为后续 Pi 任务的工作边界（S03 生效）」, buttons 重新识别 / 移除项目 with inline confirm) / stale warning card / error card (message + action). All dynamic values via `textContent`/`createElement`. Init: load status once on script load.

`public/css/project.css`: follow escort.css conventions (CSS variables already in index.css; card, badge, counts grid, mono entries, error card).

### Step 4.3: Verify + commit

```bash
node --check public/js/project.js && node --check public/js/index.js
node --test test/project-ui.test.js        # all PASS
npm test                                    # all suites PASS
git add public/js/project.js public/css/project.css public/index.html public/js/index.js test/project-ui.test.js
git commit -m "feat: add project selection view"
```

---

## Task 5: Full automated verification

**Steps:**

1. `git ls-files '*.js' | xargs -n1 node --check` — all pass.
2. `npm test` — previous 62 + new tests all pass; record count.
3. `git diff --check $(git merge-base main HEAD)..HEAD` — clean.
4. Protected-paths audit: `git diff --name-only main...HEAD` must NOT contain any path from the execution-rules forbidden list.
5. Isolated-port health: `PORT=43212 npm start` → `curl http://127.0.0.1:43212/api/health` → `ok: true`; additionally `curl` (no token) `/api/project/status` → 401; then stop only this instance.
6. `node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict` — PASS.
7. Record every command output as evidence in NOW.md 验证证据 (do not claim done).

No commit for evidence recording until Task 6 bundles it (or commit docs separately here).

---

## Task 6: Real acceptance, zero-write proof, handoff

**With the user, on the branch service (isolated port or the user's running instance):**

1. **本仓库（有未提交改动）**: before → `git status --porcelain` snapshot; user selects this repo path in UI; verify branch/dirty `.gitignore` entry/last commit match ground truth; after → `git status --porcelain` identical; also `git stash list` unchanged (zero-write proof).
2. **干净仓库**: create a temp repo with one commit (user-visible path, e.g. `/tmp/s02-acceptance-clean`); select → counts all 0; delete afterwards with user confirmation.
3. **非 Git 目录 + 不存在路径 + 文件**: distinguishable error cards.
4. **持久化与失效**: restart service → selection survives; delete temp repo → stale card; remove → cleared; remove again → no error.
5. Ask the user about `.gitignore` staging (both lines together vs. unstaged); act per answer.
6. Write results into NOW.md (需求—证据映射 for S02, 验证证据, 最近交接, 会话记录); update slice per outcome; run `--strict` validation; merge only after user acceptance, same ceremony as S01.

**Done gate:** user has personally completed scenarios 1–4 and confirms zero-write evidence. AI claims do not count.
