import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { once, EventEmitter } from "node:events";

const { default: express } = await import("express");
const { default: installRoutes, isInstalled } = await import("../src/routes/install.js");
const { STARTER_PATH, INSTALL_CATALOG, getInstallEntry } = await import("../src/install-catalog.js");

let server;
let base;

// 这两项注入是安全边界，不是便利：
//   1) spawnCalls —— 测试绝不能触达真实包管理器（曾出现假设某包未装、
//      而开发机恰好装了它，于是 `npm test` 真的跑了一次 npm install -g）。
//   2) installedView —— 闸门分支不得依赖开发机上恰好装了哪些软件，
//      否则同一份测试在别的机器/CI 上会走进"接受任务"那条分支。
let spawnCalls = [];
let installedView = null; // null = 跟随本机；Set = 固定的测试视图

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 987654;
  proc.kill = () => true;
  // 以非 0 退出：走失败分支，避免成功分支再去刷可用性/重扫工具
  setImmediate(() => proc.emit("close", 1));
  return proc;
}

before(async () => {
  const app = express();
  app.use(express.json());
  installRoutes(app, {
    spawnImpl: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return fakeProc();
    },
    isInstalledImpl: (entry) => (installedView === null ? isInstalled(entry) : installedView.has(entry.id)),
  });
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

// 每个闸门测试自己声明"本机装了哪些"，并断言拒绝路径一次 spawn 都没发生
function withInstalled(ids) {
  installedView = new Set(ids);
  spawnCalls = [];
}

function resetInstalledView() {
  installedView = null;
  spawnCalls = [];
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

test("GET /api/install/updates 返回版本与更新状态（不假设本机装了哪个具体软件）", async () => {
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
  // 不断言"某个具体软件在本机已装"：那会让测试随开发机状态翻脸。
  // 契约是"若探测到已装，则版本号必须是被真实解析出来的"。
  const probed = data.entries.filter((e) => e.installed);
  assert.ok(probed.length > 0, "测试机至少应探测到一个已装条目（node 本身）");
  for (const row of probed) {
    if (row.version !== null) {
      assert.match(String(row.version), /\d/, `${row.id}: detected version must contain a digit, got ${row.version}`);
    }
  }
  const node = byId.get("node");
  assert.equal(node.installed, true, "跑着测试的机器上 node 必然可用");
});

test("POST /api/install 的 update 闸门：未安装与导航条目一律拒绝，且不触达真实安装", async () => {
  // 视图里声明为"未安装"——与开发机实际装了什么无关
  withInstalled([]);
  try {
    const notInstalled = await req("POST", "/api/install", { id: "qwen-code", action: "update" });
    assert.equal(notInstalled.status, 400);
    assert.ok(notInstalled.data.error.includes("尚未安装"), notInstalled.data.error);

    const link = await req("POST", "/api/install", { id: "site-openai", action: "update" });
    assert.equal(link.status, 400);

    const installLink = await req("POST", "/api/install", { id: "site-deepseek" });
    assert.equal(installLink.status, 400);

    assert.deepEqual(spawnCalls, [], "被拒绝的请求绝不能启动任何子进程");
  } finally {
    resetInstalledView();
  }
});

test("卸载闸门：保护项、未安装、导航条目都被拒，且不触达真实卸载", async () => {
  // 全部声明为已安装：这样"未安装"分支不会误兜住保护项的断言
  withInstalled(["node", "homebrew", "git", "qwen-code"]);
  try {
    for (const protectedId of ["node", "homebrew", "git"]) {
      const r = await req("POST", "/api/install", { id: protectedId, action: "uninstall" });
      assert.equal(r.status, 400, `${protectedId} 必须拒绝卸载`);
      assert.ok(r.data.error.includes("基础环境"), `${protectedId}: ${r.data.error}`);
    }
    assert.deepEqual(spawnCalls, [], "保护项拒绝后不得启动子进程");
  } finally {
    resetInstalledView();
  }

  withInstalled([]);
  try {
    const missing = await req("POST", "/api/install", { id: "qwen-code", action: "uninstall" });
    assert.equal(missing.status, 400);
    assert.ok(missing.data.error.includes("尚未安装"), missing.data.error);

    const link = await req("POST", "/api/install", { id: "site-openai", action: "uninstall" });
    assert.equal(link.status, 400);

    assert.deepEqual(spawnCalls, [], "未安装/导航条目拒绝后不得启动子进程");
  } finally {
    resetInstalledView();
  }
});

test("已安装条目不得重复安装；被接受的安装只执行目录常量里的命令", async () => {
  withInstalled(["qwen-code"]);
  try {
    const dup = await req("POST", "/api/install", { id: "qwen-code" });
    assert.equal(dup.status, 400);
    assert.ok(dup.data.error.includes("已经安装"), dup.data.error);
    assert.deepEqual(spawnCalls, [], "重复安装不得启动子进程");

    // 接受路径：命令必须来自目录常量，请求体里除 id/action 之外不接受任何用户输入
    const entry = getInstallEntry("qwen-code");
    const ok = await req("POST", "/api/install", { id: "qwen-code", action: "update", command: "rm -rf /" });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(spawnCalls.length, 1, "接受后恰好启动一个任务");
    assert.equal(spawnCalls[0].cmd, "/bin/zsh");
    assert.equal(spawnCalls[0].args[0], "-lc");
    const command = spawnCalls[0].args[1];
    assert.ok(command.includes(entry.npm), `command must come from the catalog package field: ${command}`);
    assert.ok(!command.includes("rm -rf"), "client-supplied command field must never reach argv");
  } finally {
    resetInstalledView();
  }
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
  // 本机确实装着 pi 时，npm -g / brew bin 兜底探测必须把它认成可卸载；
  // 未装时不作要求（canUninstall 由归属探测决定，与本机是否安装是两件事）
  if (byId.get("pi-agent").installed) {
    assert.equal(byId.get("pi-agent").canUninstall, true, "installed pi-agent must be offerable for uninstall");
  }
  assert.ok(
    data.entries.some((e) => e.canUninstall),
    "目录里至少要有一个可卸载条目，否则控制台卸载入口永远不可用",
  );
});
