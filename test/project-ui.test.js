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

test("project.js implements an explicit confirm-before-clear flow", () => {
  assert.ok(PROJECT_JS.includes("confirming"), "clear must require an inline confirmation state");
});

test("project.js talks only to the four project endpoints", () => {
  const endpoints = [...PROJECT_JS.matchAll(/["'](\/api\/[^"']+)["']/g)].map((m) => m[1]);
  assert.ok(endpoints.length > 0);
  for (const endpoint of endpoints) {
    assert.ok(endpoint.startsWith("/api/project/"), `unexpected endpoint ${endpoint}`);
  }
});

// ── 样式存在且非空 ──

test("project.css exists and styles the project view", () => {
  assert.ok(PROJECT_CSS.trim().length > 100, "project.css must not be empty");
  assert.ok(PROJECT_CSS.includes("#project-wrap"), "project.css must style #project-wrap");
});
