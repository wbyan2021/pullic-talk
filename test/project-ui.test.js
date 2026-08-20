import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const INDEX_HTML = read("public/index.html");
const INDEX_JS = read("public/js/index.js");
const PROJECT_JS = read("public/js/project.js");
const PROJECT_CSS = read("public/css/project.css");

// ── 装配：index.html 必须包含项目 view 的完整装配 ──

test("index.html registers the project tab and view", () => {
  assert.ok(INDEX_HTML.includes('data-view="project"'), "subbar tab missing");
  assert.ok(INDEX_HTML.includes('id="project-view"'), "project view container missing");
  assert.ok(INDEX_HTML.includes('onclick="switchView(\'project\')"'), "tab must route through switchView");
});

test("index.html loads project.css and project.js", () => {
  assert.ok(INDEX_HTML.includes('href="/css/project.css"'), "project.css link missing");
  assert.ok(INDEX_HTML.includes('src="/js/project.js"'), "project.js script missing");
});

test("index.js switchView toggles project view visibility", () => {
  assert.ok(INDEX_JS.includes("#project-view"), "switchView must toggle #project-view");
});

// ── DOM 安全与数据规则 ──

test("project.js never assigns innerHTML (dynamic values must use safe DOM APIs)", () => {
  assert.ok(!PROJECT_JS.includes("innerHTML"), "innerHTML is forbidden in project.js");
  assert.ok(!PROJECT_JS.includes("insertAdjacentHTML"), "insertAdjacentHTML is forbidden in project.js");
  assert.ok(!PROJECT_JS.includes("document.write"), "document.write is forbidden in project.js");
});

test("project.js uses the authenticated OPS api and no browser persistence", () => {
  assert.ok(PROJECT_JS.includes("window.OPS.api"), "must use window.OPS.api for token-carrying requests");
  assert.ok(!PROJECT_JS.includes("localStorage"), "browser persistence is forbidden");
  assert.ok(!PROJECT_JS.includes("sessionStorage"), "browser persistence is forbidden");
  assert.ok(!PROJECT_JS.includes("indexedDB"), "browser persistence is forbidden");
});

test("project.js implements an explicit confirm-before-clear flow per card", () => {
  assert.ok(PROJECT_JS.includes("confirmingId"), "clear must require an inline confirmation state per card");
});

test("project.js talks to the five project endpoints", () => {
  const endpoints = [...PROJECT_JS.matchAll(/["'](\/api\/[^"']+)["']/g)].map((m) => m[1]);
  assert.ok(endpoints.length > 0);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.startsWith("/api/project/"), `unexpected endpoint ${endpoint}`);
  }
  for (const required of ["status", "select", "activate", "refresh", "clear"]) {
    assert.ok(
      endpoints.includes(`/api/project/${required}`),
      `endpoint /api/project/${required} missing`
    );
  }
});

test("project.js supports focus folding: non-active projects collapse when an active project exists", () => {
  assert.ok(PROJECT_JS.includes("expandedIds"), "fold state (expandedIds) missing");
  assert.ok(PROJECT_JS.includes("收起"), "collapse action missing");
  assert.ok(PROJECT_JS.includes("展开"), "expand action missing");
  assert.ok(PROJECT_JS.includes("renderCollapsedCard"), "collapsed card renderer missing");
});

test("project.js renders an ACTIVE badge and a set-active action", () => {
  assert.ok(PROJECT_JS.includes("ACTIVE"), "active badge missing");
  assert.ok(PROJECT_JS.includes("设为活动"), "set-active action missing");
  assert.ok(PROJECT_JS.includes("activeProjectId"), "must track activeProjectId from status");
});

test("project.js mounts one execution panel below the active project only", () => {
  assert.ok(PROJECT_JS.includes("executionPanel"), "project view must own the single execution panel node");
  assert.ok(PROJECT_JS.includes("project-stack"), "active project needs a card + execution stack");
  assert.ok(PROJECT_JS.includes("project.id === state.activeProjectId"), "panel mount must follow the active project id");
  assert.ok(PROJECT_JS.includes('ops:active-project-changed'), "project changes must notify the execution view");
});

test("project.js requires explicit AI handoff enablement before project writes", () => {
  assert.ok(PROJECT_JS.includes("/api/project/handoff/enable"), "handoff enable endpoint missing");
  assert.ok(PROJECT_JS.includes("启用 AI 交接"), "explicit handoff action missing");
  assert.ok(PROJECT_JS.includes("交接记录"), "handoff explanation missing");
  assert.ok(!PROJECT_JS.includes("localStorage"));
});

// ── 样式存在且非空 ──

test("project.css exists and styles the project view", () => {
  assert.ok(PROJECT_CSS.trim().length > 100, "project.css must not be empty");
  assert.ok(PROJECT_CSS.includes("#project-wrap"), "project.css must style #project-wrap");
  assert.ok(PROJECT_CSS.includes(".project-list"), "project.css must style the project list");
  assert.ok(PROJECT_CSS.includes(".project-badge.active"), "project.css must style the ACTIVE badge");
  assert.ok(PROJECT_CSS.includes(".project-card.collapsed"), "project.css must style the collapsed card");
  assert.ok(PROJECT_CSS.includes(".project-fold-row"), "project.css must style the fold row");
});
