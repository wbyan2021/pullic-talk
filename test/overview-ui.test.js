import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const INDEX_HTML = read("public/index.html");
const INDEX_JS = read("public/js/index.js");
const OVERVIEW_JS = read("public/js/overview.js");
const OVERVIEW_CSS = read("public/css/overview.css");

test("index.html registers the bilingual Overview tab and view", () => {
  assert.ok(INDEX_HTML.includes('data-view="overview"'), "overview tab missing");
  assert.ok(INDEX_HTML.includes("总览"), "Chinese overview label missing");
  assert.ok(INDEX_HTML.includes("Overview"), "English overview label missing");
  assert.ok(INDEX_HTML.includes('id="overview-view"'), "overview view missing");
  assert.ok(INDEX_HTML.includes('onclick="switchView(\'overview\')"'), "tab must route through switchView");
});

test("index.html loads overview assets and index.js toggles its lifecycle", () => {
  assert.ok(INDEX_HTML.includes('href="/css/overview.css"'), "overview.css link missing");
  assert.ok(INDEX_HTML.includes('src="/js/overview.js"'), "overview.js script missing");
  assert.ok(INDEX_JS.includes("#overview-view"), "switchView must toggle #overview-view");
  assert.ok(INDEX_JS.includes("Overview.activate"), "overview must activate when visible");
  assert.ok(INDEX_JS.includes("Overview.deactivate"), "overview must deactivate when hidden");
});

test("overview rendering uses safe DOM APIs and authenticated read-only requests", () => {
  for (const forbidden of ["innerHTML", "insertAdjacentHTML", "document.write", "localStorage", "sessionStorage", "indexedDB", "EventSource"]) {
    assert.ok(!OVERVIEW_JS.includes(forbidden), `${forbidden} is forbidden in overview.js`);
  }
  assert.ok(OVERVIEW_JS.includes("window.OPS.api"), "overview must use the authenticated API helper");
  assert.ok(OVERVIEW_JS.includes('"/api/overview"'), "overview endpoint missing");
  assert.ok(OVERVIEW_JS.includes("setInterval"), "overview polling missing");
  assert.ok(OVERVIEW_JS.includes("5000"), "overview polling interval must be five seconds");
  assert.ok(OVERVIEW_JS.includes("AbortController"), "stale overview requests must be cancellable");
});

test("overview maps task, evidence and acceptance states in Chinese and English", () => {
  for (const marker of [
    "Idle", "Running", "Stopping", "Stopped", "Failed", "Completed", "Interrupted", "Unknown",
    "Pending", "Not Run", "Passed", "Needs Review", "Accepted", "Rejected",
    "Project", "Task", "Evidence", "AI Handoff", "Next Action", "Before", "After", "Validation",
    "Recoverable", "Not Recoverable", "Recovery Source", "Open Project to Recover", "Files are not rolled back",
  ]) assert.ok(OVERVIEW_JS.includes(marker), `missing overview status marker: ${marker}`);
});

test("overview provides read-only navigation back to the Project view", () => {
  assert.ok(OVERVIEW_JS.includes('switchView("project")'), "project navigation missing");
  assert.ok(!OVERVIEW_JS.includes("/api/project/execution/start"), "overview must not start tasks");
  assert.ok(!OVERVIEW_JS.includes("/api/project/execution/stop"), "overview must not stop tasks");
  assert.ok(!OVERVIEW_JS.includes("/api/evidence/close"), "overview must not close evidence");
});

test("overview.css exists and styles the four-card layout", () => {
  assert.ok(OVERVIEW_CSS.trim().length > 300, "overview.css must not be empty");
  for (const marker of ["#overview-view", ".overview-grid", ".overview-card", ".overview-status"]) {
    assert.ok(OVERVIEW_CSS.includes(marker), `missing overview style: ${marker}`);
  }
});
