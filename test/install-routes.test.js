import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { once } from "node:events";

const { default: express } = await import("express");
const { default: installRoutes } = await import("../src/routes/install.js");
const { STARTER_PATH, INSTALL_CATALOG } = await import("../src/install-catalog.js");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  installRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text || "{}"), text };
}

test("GET /api/install/catalog 返回新手推荐顺序与完整条目", async () => {
  const { status, data } = await req("GET", "/api/install/catalog");
  assert.equal(status, 200);
  assert.equal(typeof data.brewAvailable, "boolean");
  assert.deepEqual(data.starter, STARTER_PATH);
  assert.ok(Array.isArray(data.entries) && data.entries.length >= 30, "catalog should cover env + agents + apps + model sites");
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  for (const id of STARTER_PATH) assert.ok(byId.has(id), `starter id ${id} must be in entries`);
});

test("官网导航条目以 link 方式返回，可安装条目返回择优方式", async () => {
  const { data } = await req("GET", "/api/install/catalog");
  const link = data.entries.find((e) => e.id === "site-deepseek");
  assert.equal(link.method, "link");
  assert.equal(link.methodLabel, "官网");
  assert.equal(link.installed, false);

  const node = data.entries.find((e) => e.id === "node");
  // 测试机跑着本驾驶舱，node 必然已安装；目录不得给它再派安装任务
  assert.equal(node.installed, true);
  assert.equal(node.method, null);

  for (const e of data.entries) {
    assert.ok(![e.method, e.methodLabel, e.id, e.name].some((v) => v === undefined), `${e.id}: contract fields must be present`);
  }
});

test("POST /api/install 拒绝未知 id 与官网导航条目，绝不启动真实安装", async () => {
  const bad = await req("POST", "/api/install", { id: "not-in-catalog" });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.error.includes("未知安装条目"));

  const link = await req("POST", "/api/install", { id: "site-openai" });
  assert.equal(link.status, 400);
  assert.ok(link.data.error.includes("仅提供官网导航"));

  const missing = await req("POST", "/api/install", {});
  assert.equal(missing.status, 400);
});

test("目录事实与源码常量一致（防止路由另建第二套数据）", async () => {
  const { data } = await req("GET", "/api/install/catalog");
  assert.equal(data.entries.length, INSTALL_CATALOG.length);
});

test("GET /api/install/updates 返回版本与更新状态（pi 已安装且带版本）", async () => {
  const { status, data } = await req("GET", "/api/install/updates");
  assert.equal(status, 200);
  assert.equal(typeof data.scannedAt, "number");
  assert.ok(Array.isArray(data.entries) && data.entries.length === INSTALL_CATALOG.length);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  for (const row of data.entries) {
    assert.equal(typeof row.updateAvailable, "boolean", `${row.id}: updateAvailable must be boolean`);
    if (!row.installed) continue;
    assert.equal(row.updateAvailable && row.latest === null, false, `${row.id}: update must carry latest when available`);
  }
  const pi = byId.get("pi-agent");
  assert.equal(pi.installed, true, "pi agent is installed on this machine");
  assert.match(pi.version || "", /^\d+\.\d+/, `pi version should be detected, got ${pi.version}`);
  const node = byId.get("node");
  assert.equal(node.installed, true);
  assert.match(node.version || "", /^\d+\./, "node version should be detected");
});

test("POST /api/install 的 update 动作有闸门：未安装/导航条目一律拒绝", async () => {
  // qwen-code 在本机未安装：更新必须被拒，且绝不启动任务
  const notInstalled = await req("POST", "/api/install", { id: "qwen-code", action: "update" });
  assert.equal(notInstalled.status, 400);
  assert.ok(notInstalled.data.error.includes("尚未安装"));

  const link = await req("POST", "/api/install", { id: "site-openai", action: "update" });
  assert.equal(link.status, 400);

  // 未安装条目不带 action 的正常安装分支保持原语义（这里只验证拒绝逻辑，不真装）
  const installLink = await req("POST", "/api/install", { id: "site-deepseek" });
  assert.equal(installLink.status, 400);
});

test("卸载闸门：保护项拒绝、未安装拒绝、导航条目拒绝，绝不真卸载", async () => {
  // 基础环境保护（驾驶舱自身依赖）
  const node = await req("POST", "/api/install", { id: "node", action: "uninstall" });
  assert.equal(node.status, 400);
  assert.ok(node.data.error.includes("基础环境"), node.data.error);

  const brew = await req("POST", "/api/install", { id: "homebrew", action: "uninstall" });
  assert.equal(brew.status, 400);

  const git = await req("POST", "/api/install", { id: "git", action: "uninstall" });
  assert.equal(git.status, 400);

  // 未安装条目不可卸载（qwen-code 本机未装）
  const missing = await req("POST", "/api/install", { id: "qwen-code", action: "uninstall" });
  assert.equal(missing.status, 400);
  assert.ok(missing.data.error.includes("尚未安装"));

  // 官网导航条目不可卸载
  const link = await req("POST", "/api/install", { id: "site-openai", action: "uninstall" });
  assert.equal(link.status, 400);
});

test("目录为已安装条目返回 canUninstall，保护项与导航条目恒为 false", async () => {
  const { data } = await req("GET", "/api/install/catalog");
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  for (const e of data.entries) {
    assert.equal(typeof e.canUninstall, "boolean", `${e.id}: canUninstall must be boolean`);
  }
  for (const protectedId of ["node", "homebrew", "git"]) {
    assert.equal(byId.get(protectedId).canUninstall, false, `${protectedId} 不可卸载`);
  }
  assert.equal(byId.get("site-deepseek").canUninstall, false, "导航条目不可卸载");
  // 本机 npm 全局装的 pi 应可卸载（npmBinDir 兜底探测命中）
  assert.equal(byId.get("pi-agent").canUninstall, true);
});
