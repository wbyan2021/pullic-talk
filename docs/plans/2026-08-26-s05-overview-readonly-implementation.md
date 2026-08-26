# S05-A Read-only Overview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a read-only bilingual Overview page that summarizes the active project, current Pi task, evidence, and AI handoff without creating a second source of truth or exposing sensitive data.

**Architecture:** Add a small authenticated `GET /api/overview` aggregation route that composes the existing project boundary and task-evidence services plus a narrowly parsed AI handoff summary. Add a top-level Overview view whose browser code renders safe DOM nodes, polls only while visible, and links back to the existing Project view for actions; no new persistence or mutation path is introduced.

**Tech Stack:** Node.js ESM, Express 4, native `node:test`, plain HTML/CSS/JavaScript, existing Token auth gate and project/execution/evidence services.

---

## Scope and protected boundaries

- Work only on `codex/v0.1-s05-overview-readonly`, based on the accepted S04 branch tip.
- S05-A is medium risk and read-only. Do not implement restore, checkpoints, file rollback, task start/stop, config writes, or multi-task execution.
- Do not read, print, or commit `.token`, real `.env` files, `~/.secrets.env`, Keychain values, personal data, or raw stderr/output.
- Preserve the existing Project, Execution, Evidence, Chat, Escort, Terminal, and Installer behavior.
- Keep WIP=1: this is the only product-code work branch and the only active implementation slice.

### Task 1: Add a safe handoff summary reader

**Files:**
- Modify: `src/services/ai-handoff.js`
- Test: `test/ai-handoff.test.js`

**Step 1: Write failing tests**

Add tests for `readSummary({ repoRoot })` that cover:

- managed `docs/ai-ops/NOW.md` returns only `taskStatus` and bounded `nextAction`;
- missing, unmanaged/conflicting, malformed, and overlong files return a safe unavailable result or stable `AiHandoffError` without exposing file contents;
- input is limited to a validated repository root and the method never writes files or reads `records/`.

Run: `node --test test/ai-handoff.test.js`

Expected: FAIL because `readSummary` is not exported.

**Step 2: Implement the minimal reader**

- Reuse `pathsFor`, `exists`, and the managed marker check.
- Parse only frontmatter lines beginning with `task_status:` and `next_action:`; cap the action at 300 UTF-8-safe characters and pass it through the existing redactor.
- Return `{ state: "ready", taskStatus, nextAction }` only for a managed file with a valid bounded action; return `{ state: "unavailable", taskStatus: null, nextAction: null }` for missing/conflicting/unparseable content.
- Export `readSummary` with the existing writer factory; do not alter write or enable semantics.

Run: `node --test test/ai-handoff.test.js`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/services/ai-handoff.js test/ai-handoff.test.js
git commit -m "feat: read safe ai handoff summary"
```

### Task 2: Build the read-only overview aggregation route

**Files:**
- Create: `src/routes/overview.js`
- Modify: `src/server.js`
- Test: `test/overview-routes.test.js`

**Step 1: Write failing route tests**

Cover:

- route registration and authenticated mounting through the existing `/api` gate;
- active project projection with branch, HEAD, counts, stale and handoff state;
- idle/no-task response with neutral `available: false` evidence;
- execution/evidence projections omit task text, raw output, stderr, cwd, args and path arrays;
- `nextAction` comes only from `readSummary`, is bounded/redacted, and unavailable handoff does not become success;
- service failures return the existing safe `internal_error` shape and do not leak raw messages.

Run: `node --test test/overview-routes.test.js`

Expected: FAIL because the route and app wiring do not exist.

**Step 2: Implement route projection**

- Create explicit projection helpers for project, execution, evidence, validation, Git summary, handoff and next action.
- Call `projectBoundary.getStatus()`, `taskEvidence.getEvidenceStatus()`, and `aiHandoff.readSummary()` only for the active project.
- Treat no active project and no current task as safe empty states; do not throw for normal idle conditions.
- Return only the fields in the design spec and never include raw task/output/stderr or full changed-path arrays.
- Add `overviewRoutes(app, dependencies)` and mount it after the existing auth gate in `src/server.js`.

Run: `node --test test/overview-routes.test.js`

Expected: PASS.

**Step 3: Commit**

```bash
git add src/routes/overview.js src/server.js test/overview-routes.test.js
git commit -m "feat: expose read-only overview route"
```

### Task 3: Add the Overview page and lifecycle

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/index.js`
- Create: `public/js/overview.js`
- Create: `public/css/overview.css`
- Test: `test/overview-ui.test.js`

**Step 1: Write failing UI contract tests**

Assert that:

- the top-level bilingual tab and `#overview-view` exist and are wired through `switchView`;
- overview assets are loaded;
- dynamic rendering uses safe DOM APIs and no browser persistence/EventSource;
- the page references only `GET /api/overview` and the existing Project navigation;
- status mappings include idle, running, stopped, failed, completed, interrupted, unknown, pending, accepted, needs_review and rejected.

Run: `node --test test/overview-ui.test.js`

Expected: FAIL because the page and module do not exist.

**Step 2: Implement safe rendering and polling**

- Add the Overview tab and view without moving the existing Project/Execution DOM.
- Implement a small state object, `loadOverview`, card renderers, bilingual status helpers, empty/error states and link-back buttons.
- Render only the allowed summary fields; never inject HTML from API data.
- Start one immediate load and a 5-second interval while the view is active; abort/ignore stale responses when leaving or reloading.
- Keep the last successful card data when one projection fails, but label it unavailable/stale rather than presenting it as current.

Run: `node --test test/overview-ui.test.js`

Expected: PASS.

**Step 3: Commit**

```bash
git add public/index.html public/js/index.js public/js/overview.js public/css/overview.css test/overview-ui.test.js
git commit -m "feat: add read-only overview page"
```

### Task 4: Documentation and verification

**Files:**
- Modify: `docs/NOW.md`
- Modify: `docs/PRODUCT.md`
- Modify: `docs/CODEMAP.md`
- Modify: `docs/ai-ops/NOW.md`

**Step 1: Run focused verification**

Run:

```bash
node --test test/ai-handoff.test.js test/overview-routes.test.js test/overview-ui.test.js
git ls-files '*.js' | xargs -n1 node --check
git diff --check
```

Expected: all focused tests pass; syntax and diff checks are clean.

**Step 2: Run the full regression and strict state validation**

Run:

```bash
node --test
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
```

Expected: all tests pass, strict structural validation passes, and no generated/private files are staged.

**Step 3: Update facts and commit**

- Mark S05-A implementation evidence in `NOW.md` without marking the broader S05 recovery scope done.
- Record the new route/UI paths in `CODEMAP.md` and the read-only overview behavior in `PRODUCT.md`.
- Update the AI handoff `next_action` to the user-facing overview acceptance checklist.
- Keep the multi-task question recorded as a non-goal; do not change the v0.1 single-task boundary.

```bash
git add docs/NOW.md docs/PRODUCT.md docs/CODEMAP.md docs/ai-ops/NOW.md
git commit -m "docs: record s05 overview implementation"
```

### Task 5: User acceptance

1. Start the service on isolated port `43211` and open the Overview tab.
2. Verify no-project, idle, running, completed, stopped/failed and stale-project states without using real credentials.
3. Compare project branch/HEAD/counts and evidence statuses with the existing Project view.
4. Confirm the page contains no raw task text, validation output, stderr, Key or Token, and leaving the tab stops polling.
5. Record `accepted`, `needs_review`, or a concrete defect in `docs/NOW.md`; do not mark broader S05 recovery done.

