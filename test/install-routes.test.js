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
