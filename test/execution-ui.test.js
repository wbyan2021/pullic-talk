import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const INDEX_HTML = read("public/index.html");
const EXECUTION_JS = read("public/js/execution.js");
const EXECUTION_CSS = read("public/css/execution.css");

// ── 装配 ──

test("index.html mounts the execution panel and loads its assets inside project view", () => {
  assert.ok(INDEX_HTML.includes('id="execution-panel"'), "execution-panel mount point missing");
  assert.ok(INDEX_HTML.includes('href="/css/execution.css"'), "execution.css link missing");
  assert.ok(INDEX_HTML.includes('src="/js/execution.js"'), "execution.js script missing");
  const panelPos = INDEX_HTML.indexOf('id="execution-panel"');
  const viewPos = INDEX_HTML.indexOf('id="project-view"');
  assert.ok(panelPos > viewPos, "execution panel must live inside the project view");
});

// ── DOM 安全与数据规则 ──

test("execution.js never assigns innerHTML (dynamic values must use safe DOM APIs)", () => {
  assert.ok(!EXECUTION_JS.includes("innerHTML"), "innerHTML is forbidden");
  assert.ok(!EXECUTION_JS.includes("insertAdjacentHTML"), "insertAdjacentHTML is forbidden");
  assert.ok(!EXECUTION_JS.includes("document.write"), "document.write is forbidden");
});

test("execution.js uses the authenticated OPS api and no browser persistence", () => {
  assert.ok(EXECUTION_JS.includes("window.OPS.api"), "must use window.OPS.api for token-carrying requests");
  assert.ok(!EXECUTION_JS.includes("localStorage"), "browser persistence is forbidden");
  assert.ok(!EXECUTION_JS.includes("sessionStorage"), "browser persistence is forbidden");
  assert.ok(!EXECUTION_JS.includes("indexedDB"), "browser persistence is forbidden");
});

test("execution.js requires explicit risk confirmation before starting", () => {
  assert.ok(EXECUTION_JS.includes("riskConfirmed"), "start must be gated by an explicit risk confirmation state");
});

test("execution.js protects user input from polling re-renders", () => {
  assert.ok(EXECUTION_JS.includes("executionSnapshot"), "polling must skip re-render when execution state is unchanged");
  assert.ok(EXECUTION_JS.includes("setSelectionRange"), "textarea focus and caret must survive re-renders");
  assert.ok(EXECUTION_JS.includes("exec-elapsed"), "running view must show elapsed time");
});

test("execution.js leaves the running view when a terminal SSE event arrives", () => {
  assert.ok(EXECUTION_JS.includes('state.streaming = false'), "done event must release the streaming UI state");
  assert.ok(EXECUTION_JS.includes('eventType === "done"'), "terminal SSE event must be handled explicitly");
});

test("execution.js consumes SSE via fetch reader + TextDecoder (no EventSource token leakage)", () => {
  assert.ok(EXECUTION_JS.includes("getReader"), "SSE must be consumed via response.body.getReader()");
  assert.ok(EXECUTION_JS.includes("TextDecoder"), "SSE bytes must be decoded with TextDecoder");
  assert.ok(!EXECUTION_JS.includes("EventSource"), "EventSource cannot carry the auth token");
});

test("execution.js talks only to project endpoints", () => {
  const endpoints = [...EXECUTION_JS.matchAll(/["'](\/api\/[^"']+)["']/g)].map((m) => m[1]);
  assert.ok(endpoints.length > 0);
  const allowed = new Set([
    "/api/project/status",
    "/api/project/execution/status",
    "/api/project/execution/start",
    "/api/project/execution/stop",
    "/api/evidence/status",
    "/api/evidence/validation/preview",
    "/api/evidence/validation/run",
    "/api/evidence/close",
  ]);
  for (const endpoint of endpoints) {
    assert.ok(allowed.has(endpoint), `unexpected endpoint ${endpoint}`);
  }
  for (const required of [
    "/api/project/execution/status",
    "/api/project/execution/start",
    "/api/project/execution/stop",
  ]) {
    assert.ok(endpoints.includes(required), `${required} missing`);
  }
});

test("execution.js exposes timeline, Git evidence, validation, and acceptance states", () => {
  for (const marker of ["时间线", "Git 证据", "验收", "validation", "accepted", "needs_review", "interrupted", "/api/evidence/status", "/api/evidence/close"]) {
    assert.ok(EXECUTION_JS.includes(marker), `missing S04 UI marker: ${marker}`);
  }
});

// ── 样式 ──

test("execution.css exists and styles the panel", () => {
  assert.ok(EXECUTION_CSS.trim().length > 100, "execution.css must not be empty");
  assert.ok(EXECUTION_CSS.includes("#execution-panel"), "must style #execution-panel");
  assert.ok(EXECUTION_CSS.includes(".exec-status-light"), "must style the status light");
  assert.ok(EXECUTION_CSS.includes("#project-view.active"), "panel must not squeeze the project list: view becomes one scroll flow");
});
