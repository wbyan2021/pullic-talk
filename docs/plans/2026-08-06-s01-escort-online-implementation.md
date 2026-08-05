---
type: implementation-plan
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S01-escort-online
status: implemented-awaiting-acceptance
risk_level: high
branch: codex/v0.1-s01-escort-online
updated: 2026-08-06
design: ./2026-08-06-s01-escort-online-design.md
---

# S01 Escort Online Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a secure DeepSeek-backed escort AI to the existing local cockpit so a user can save/test/delete a Key and chat independently of every CLI Agent.

**Architecture:** Keep the existing CLI chat untouched. Add a macOS Keychain credential adapter, a DeepSeek Provider adapter, and an Escort Service that owns safe state transitions; expose them through authenticated local routes and a persistent right-side panel on the existing home page.

**Tech Stack:** Node.js ESM, Node built-in `fetch`, `child_process.spawn`, Node built-in test runner, Express 4, native HTML/CSS/JavaScript, macOS `/usr/bin/security`.

## Execution result

Tasks 1–6 and the no-real-Key portion of Task 7 were completed on `codex/v0.1-s01-escort-online`. The implementation remains intentionally short of S01 `done` because the user has not yet performed the real-Key browser acceptance.

| Area | Result |
|---|---|
| Credential Store | Implemented and covered by 8 tests, including a child-process timeout that rejects even if `SIGTERM` is ignored; no real Keychain mutation performed |
| DeepSeek Provider | Implemented and covered by 13 tests; no real network/charged request performed |
| Escort Service | Implemented and covered by 14 tests; independent of CLI Agents |
| Authenticated routes | Implemented and covered by 22 tests, including nested error-text replacement and safe status-field whitelisting |
| Escort panel | Implemented; desktop 1280×720 and narrow 760×720 browser checks passed without console errors |
| Full automated evidence | `npm test` 57/57, syntax checks, `git diff --check`, isolated-port health and strict project-state validation passed |
| Remaining gate | User enters their own Key in the browser and completes design §12.2 without sharing it with AI |

---

## Execution rules

- Work only on `codex/v0.1-s01-escort-online`.
- Follow [S01 design](./2026-08-06-s01-escort-online-design.md) and [ADR-002](../decisions/ADR-002-provider-control-plane-and-keychain.md).
- Do not read `.token`, a real API Key, existing Keychain secret values, or user personal data.
- Do not modify `.gitignore`, `src/agent-caller.js`, `src/routes/api.js`, `public/js/chat.js`, `public/vendor/`, `agents.config.json`, `tools.json`, or `package-lock.json`.
- Use fake secrets in tests. Assert fake secrets never appear in process arguments, errors, logs, API responses, or DOM text.
- Keep local HTTP `401` reserved for cockpit authentication; never pass through DeepSeek `401`.
- Do not mark S01 done without the user's later real-Key browser acceptance.
- Commit only known files for this slice; leave unrelated user changes unstaged.

## Task 1: Establish the test harness and secure Keychain adapter

**Files:**

- Modify: `package.json`
- Create: `src/services/credential-store.js`
- Create: `test/credential-store.test.js`

**Step 1: Add the Node test command**

Add exactly this script without changing dependencies:

```json
"test": "node --test"
```

**Step 2: Write failing credential-store tests**

Use `node:test` and `node:assert/strict`. Inject a fake `runSecurity(args, options)` and verify:

1. `set("fake-secret-123456")` calls `add-generic-password`, includes fixed account/service/label and `-U`, ends argv with `-w`, passes the secret only as `options.stdin`, and does not include it in `args`.
2. `has()` calls `find-generic-password` without `-w`, returning only true/false.
3. `get()` calls `find-generic-password` with `-w` and trims the final newline.
4. `delete()` treats the fixed not-found result as success.
5. other command failures become `CredentialStoreError` with stable code `credential_store_unavailable` and no raw secret/output.
6. non-darwin construction/operation returns `unsupported_platform` and never falls back to a file.

The module contract must be:

```js
export class CredentialStoreError extends Error {
  constructor(code, message, options = {}) { /* stable public fields only */ }
}

export function createSecurityRunner({ spawnImpl, timeoutMs } = {}) {
  return async function runSecurity(args, { stdin } = {}) { /* bounded stdout/stderr */ };
}

export function createCredentialStore({ runSecurity, platform = process.platform } = {}) {
  return {
    async has() {},
    async get() {},
    async set(secret) {},
    async delete() {},
  };
}
```

Fixed identifiers:

```js
const SERVICE = "com.ai-ops.cockpit.provider.deepseek";
const ACCOUNT = "default";
const LABEL = "AI·OPS COCKPIT · DeepSeek";
```

**Step 3: Run the test and confirm RED**

Run:

```bash
node --test test/credential-store.test.js
```

Expected: FAIL because the module or exports do not exist.

**Step 4: Implement the minimal adapter**

- Spawn only absolute `/usr/bin/security`; never invoke a shell.
- Bound execution to 10 seconds and each output stream to 8 KiB.
- For save use argv `add-generic-password ... -U -w` with `-w` last, then `child.stdin.end(secret + "\n")`.
- For `has`, do not request or capture a password value.
- For `get`, capture stdout internally and never log it.
- Detect item-not-found by exit status and known Keychain not-found wording, but never expose raw stderr.
- Make delete idempotent.

**Step 5: Run GREEN and syntax checks**

```bash
node --test test/credential-store.test.js
node --check src/services/credential-store.js
```

Expected: all credential tests pass and syntax check exits 0.

**Step 6: Commit known Task 1 files**

```bash
git add package.json src/services/credential-store.js test/credential-store.test.js
git commit -m "feat: add secure keychain credential store"
```

## Task 2: Add the DeepSeek Provider adapter with stable failures

**Files:**

- Create: `src/providers/deepseek.js`
- Create: `test/deepseek-provider.test.js`

**Step 1: Write failing Provider tests**

Inject `fetchImpl`. Cover:

1. request URL is `https://api.deepseek.com/chat/completions`;
2. Authorization header carries the fake Key, body uses `deepseek-v4-flash`, thinking disabled, non-streaming, bounded `max_tokens`, and sanitized messages;
3. success returns only `{ text, model }` and never reasoning content;
4. 401 → `credential_invalid`;
5. 402 → `insufficient_balance`;
6. 429 → `rate_limited`;
7. 400/422 → `provider_request_invalid`;
8. 500/503/other 5xx → `provider_unavailable`;
9. rejected fetch → `network_error`;
10. timeout abort → `timeout`;
11. malformed 2xx payload → `invalid_response`;
12. thrown errors never contain the fake Key or upstream raw error body.

Required interface:

```js
export class ProviderError extends Error {
  constructor(code, message, { retryable, availability, httpStatus, cause } = {}) {}
}

export function createDeepSeekProvider({
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  model = "deepseek-v4-flash",
} = {}) {
  return {
    async complete({ apiKey, messages, maxTokens, signal }) {},
  };
}
```

**Step 2: Run RED**

```bash
node --test test/deepseek-provider.test.js
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the adapter**

- Use an internal `AbortController`; distinguish timer abort from caller abort.
- Send only `model`, `messages`, `thinking: { type: "disabled" }`, `max_tokens`, and `stream: false`.
- Parse text with `JSON.parse((await response.text()).trim())` so leading keep-alive whitespace is harmless.
- Accept only non-empty `choices[0].message.content`.
- Return safe constants for all public errors; do not concatenate upstream bodies or native network messages.
- Clear timeout and listeners in `finally`.

**Step 4: Run GREEN**

```bash
node --test test/deepseek-provider.test.js
node --check src/providers/deepseek.js
```

**Step 5: Commit Task 2**

```bash
git add src/providers/deepseek.js test/deepseek-provider.test.js
git commit -m "feat: add deepseek provider adapter"
```

## Task 3: Add the Escort Service and state machine

**Files:**

- Create: `src/services/escort-service.js`
- Create: `test/escort-service.test.js`

**Step 1: Write failing service tests**

Inject fake `credentialStore`, `provider`, and `now`. Verify:

1. no Key → `unconfigured`;
2. stored Key after process start → `unchecked`;
3. `saveCredential` trims outer whitespace, rejects length/internal whitespace, saves once, and returns masked `unchecked` state;
4. `deleteCredential` is idempotent and resets state;
5. successful `checkConnection` transitions `checking → available` and records time;
6. 402/429 transition to `limited`; all other Provider errors transition to `unavailable` with stable safe error;
7. successful chat uses only sanitized last 12 user/assistant messages and returns `{ text, model, provider }`;
8. chat has a fixed system message that says it has no tools and must not claim actions were executed;
9. a second in-flight check/chat fails with `busy`;
10. service has no import or dependency on Agent/CLI modules;
11. status and API results never contain the Key.

Required interface:

```js
export class EscortServiceError extends Error {
  constructor(code, message, options = {}) {}
}

export function createEscortService({ credentialStore, provider, now = () => new Date() }) {
  return {
    async getStatus() {},
    async saveCredential(apiKey) {},
    async deleteCredential() {},
    async checkConnection({ signal } = {}) {},
    async sendMessage({ message, history, signal }) {},
  };
}
```

Safe public state:

```js
{
  provider: "deepseek",
  configured: Boolean,
  display: configured ? "••••••••（已安全保存）" : null,
  availability: "unconfigured|unchecked|checking|available|limited|unavailable",
  lastCheckedAt: String|null,
  error: { code, message, action, retryable }|null
}
```

**Step 2: Run RED**

```bash
node --test test/escort-service.test.js
```

**Step 3: Implement minimal orchestration**

- Keep state only in memory.
- Read Key only immediately before a Provider call; do not keep it on service state.
- Limit user message to 8,000 chars, history to 12 items / 30,000 chars.
- Connection check sends a minimal `只回复 OK` request with at most 8 output tokens.
- Chat uses at most 1,024 output tokens.
- Always release the in-flight lock in `finally`.
- Map Credential Store failures to `credential_store_unavailable` / `unsupported_platform` without raw details.

**Step 4: Run GREEN**

```bash
node --test test/escort-service.test.js
node --check src/services/escort-service.js
```

**Step 5: Commit Task 3**

```bash
git add src/services/escort-service.js test/escort-service.test.js
git commit -m "feat: add escort service state machine"
```

## Task 4: Expose authenticated routes and wire the server

**Files:**

- Create: `src/routes/escort.js`
- Create: `test/escort-routes.test.js`
- Modify: `src/server.js`

**Step 1: Write failing route tests**

Avoid adding Supertest. Export small route handlers or use a fake app that records registered handlers. Verify:

1. exact methods/paths from the design are registered;
2. status returns only safe fields;
3. PUT requires `apiKey` and never echoes it;
4. DELETE is idempotent;
5. check returns a structured status even when Provider validation fails;
6. message input errors return 400;
7. Provider credential failure is not returned as local HTTP 401;
8. timeout maps to 504, dependency failures to 424/502, conflict/busy to 409;
9. cost-bearing check/chat share a local 12-per-minute limiter;
10. thrown unknown errors return a fixed 500 body without stack/message leakage.

Required registration:

```js
export default function escortRoutes(app, { escortService, now = () => Date.now() }) {
  app.get("/api/providers/deepseek/status", ...);
  app.put("/api/providers/deepseek/credential", ...);
  app.delete("/api/providers/deepseek/credential", ...);
  app.post("/api/providers/deepseek/check", ...);
  app.post("/api/escort/messages", ...);
}
```

**Step 2: Run RED**

```bash
node --test test/escort-routes.test.js
```

**Step 3: Implement routes**

- Rely on the existing `app.use("/api", authGate)`; do not add exemptions.
- Abort the upstream request when the response closes before completion.
- Keep the limiter in the route closure and prune old timestamps.
- Use stable JSON `{ ok, code?, message?, action?, retryable?, status?, reply? }`.

**Step 4: Wire dependencies in `src/server.js`**

Import and instantiate:

```js
const credentialStore = createCredentialStore();
const deepSeekProvider = createDeepSeekProvider();
const escortService = createEscortService({ credentialStore, provider: deepSeekProvider });
escortRoutes(app, { escortService });
```

Mount after `authGate` and alongside existing routes. Do not alter existing server, terminal, auth, or shutdown behavior.

**Step 5: Run focused and full tests**

```bash
node --test test/escort-routes.test.js
npm test
node --check src/routes/escort.js
node --check src/server.js
```

**Step 6: Commit Task 4**

```bash
git add src/routes/escort.js src/server.js test/escort-routes.test.js
git commit -m "feat: expose escort provider routes"
```

## Task 5: Build the persistent escort panel

**Files:**

- Create: `public/js/escort.js`
- Create: `public/css/escort.css`
- Modify: `public/index.html`

**Step 1: Add static panel structure**

Wrap the existing `#views` and a new `<aside id="escort-panel">` in `<main id="cockpit-body">`. Keep every existing view and handler. Add:

- a top-bar `#escort-toggle` status button;
- `#escort-status-dot`, `#escort-status-label`, `#escort-status-message`;
- `#escort-key-form` with password input and `保存并检测`;
- fixed masked-display area and official DeepSeek Key link;
- retry, replace, and delete controls;
- `#escort-messages` and `#escort-chat-form`;
- a small disclosure that messages are sent to DeepSeek and not persisted locally.

Load `/css/escort.css` after current styles and `/js/escort.js` after `/js/index.js`.

**Step 2: Implement panel state in an IIFE**

Do not declare another global `$`. Use DOM APIs inside an IIFE.

Required flow:

1. load safe status on DOM ready;
2. submit Key → PUT → clear input in `finally` → POST check → render;
3. retry → POST check;
4. replace → reveal empty input without retrieving a Key;
5. delete → one `window.confirm` → DELETE → clear in-memory messages;
6. send → append user text with `textContent` → POST → append reply with `textContent`;
7. keep at most 12 in-memory messages;
8. disable cost-bearing buttons while a request is active;
9. parse safe non-2xx JSON and show a single recommended action;
10. update top-bar and panel status classes for every availability state.

No message, error, or model content may enter `innerHTML`.

**Step 3: Add responsive CSS**

- Desktop: fixed 380–400 px right rail beside the existing views.
- Narrow screens: panel becomes a full-height overlay controlled by `#escort-toggle` and close button.
- Preserve scrollability of the launchpad, install view, chat iframe, panel messages, and forms.
- Use existing CSS variables and both light/dark themes.
- Provide visible focus states and accessible disabled states.

**Step 4: Static checks**

```bash
node --check public/js/escort.js
rg -n "innerHTML|localStorage|sessionStorage|indexedDB" public/js/escort.js
```

Expected: syntax passes; forbidden persistence is absent; any `innerHTML` match must be absent.

**Step 5: Commit Task 5**

```bash
git add public/index.html public/js/escort.js public/css/escort.css
git commit -m "feat: add persistent escort panel"
```

## Task 6: Verify the full slice without a real Key

**Files:**

- Modify if required by evidence: files already in scope only
- Update: `docs/NOW.md`
- Update: `docs/CODEMAP.md`

**Step 1: Run all automated evidence**

```bash
npm test
node --check src/providers/deepseek.js
node --check src/services/credential-store.js
node --check src/services/escort-service.js
node --check src/routes/escort.js
node --check public/js/escort.js
git diff --check
```

Expected: all pass.

**Step 2: Run the project-state gate**

The slice was changed to `stage: build`, `slice_status: active` immediately before Task 1. Confirm it remains accurate, then run:

```bash
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
```

Expected: PASS and observed branch matches the recorded branch.

**Step 3: Start on an isolated port**

Use port `43211`; do not touch the unknown process on `3210`.

```bash
PORT=43211 npm start
curl http://127.0.0.1:43211/api/health
curl http://127.0.0.1:43211/
```

Expected: health has `ok: true`; HTML contains `escort-panel`; stop only the process started for this verification.

Do not read `.token`. Authenticated state and credential endpoints are verified by unit/handler tests and later through the browser UI.

**Step 4: Visual review**

Open `http://127.0.0.1:43211/` in a controlled local browser. Verify desktop and narrow layout:

1. existing console remains usable;
2. escort panel shows `unconfigured` or a safe Keychain error, never a secret;
3. forms, status, chat disabled state, and mobile overlay have no clipping;
4. no console errors;
5. take a local screenshot as visual evidence only if it contains no secret.

**Step 5: Security review**

Inspect the complete diff and verify every checkbox in design §13 that can be proven without a real Key. Search only source/test files for fake-test-secret and known credential field names; never search for or print a user's real Key.

**Step 6: Update facts**

In `docs/NOW.md`:

- record exact test counts and commands;
- update the requirements—evidence mapping;
- state that real Key / DeepSeek / Keychain acceptance remains pending user;
- set `stage: review`, keep `slice_status: active` because real acceptance is incomplete;
- set the unique next action to the user's browser acceptance.

In `docs/CODEMAP.md`, add only actual new stable paths and the `npm test` command.

**Step 7: Commit verification and docs**

```bash
git add AGENTS.md docs
git commit -m "docs: record s01 design and verification"
```

Do not stage `.gitignore`.

## Task 7: Final branch audit and handoff

**Files:**

- No product changes unless verification found an in-scope defect.

**Step 1: Re-run final evidence from a clean process state**

```bash
npm test
git diff --check
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
git status --short
git log --oneline --decorate -8
```

**Step 2: Audit scope**

Confirm:

- branch is `codex/v0.1-s01-escort-online`;
- `.gitignore` remains an unstaged user change;
- no forbidden files changed;
- no real secret appears in tracked files or commit messages;
- the only unresolved Done evidence is the user's real-Key browser acceptance.

**Step 3: Leave a sleep-safe handoff**

Final report must lead with the working result, list exact evidence, link the implementation/design/NOW files, and give one next action: the user opens the local page and completes the real-Key acceptance without sharing the Key with AI.
