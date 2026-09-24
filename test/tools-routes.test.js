import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const tmp = mkdtempSync(join(tmpdir(), "tools-routes-"));
process.env.TOOLS_JSON_PATH = join(tmp, "tools.json");
writeFileSync(process.env.TOOLS_JSON_PATH, JSON.stringify({
  version: 1,
  services: {},
  tools: [
    { id: "pi", name: "Pi Agent", kind: "cli", category: "agent", installed: true },
    { id: "vscode", name: "VS Code", kind: "app", category: "editor", installed: true },
    { id: "lmstudio", name: "LM Studio", kind: "app", category: "model", installed: true },
    { id: "totally-unknown", name: "未知工具", kind: "app", category: "utility", installed: true },
  ],
}));

const { default: express } = await import("express");
const { default: toolsRoutes } = await import("../src/routes/tools.js");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  toolsRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("GET /api/tools 为每个工具注入 installId（扫描器 id → 安装目录 id）", async () => {
  const res = await fetch(base + "/api/tools");
  assert.equal(res.status, 200);
  const data = await res.json();
  const byId = new Map(data.tools.map((t) => [t.id, t]));

  // 命名不一致的显式映射
  assert.equal(byId.get("pi").installId, "pi-agent");
  assert.equal(byId.get("lmstudio").installId, "lm-studio");
  // 同名直通
  assert.equal(byId.get("vscode").installId, "vscode");
  // 安装目录之外的扫描发现工具：null（前端不显示卸载按钮）
  assert.equal(byId.get("totally-unknown").installId, null);

  for (const t of data.tools) {
    assert.ok("installId" in t, `${t.id}: installId 字段必须存在（可为 null）`);
  }
});
