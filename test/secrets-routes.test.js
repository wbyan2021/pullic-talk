import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const tmp = mkdtempSync(join(tmpdir(), "secrets-routes-"));
process.env.SECRETS_ENV_PATH = join(tmp, ".secrets.env");

const { default: express } = await import("express");
const { default: secretsRoutes } = await import("../src/routes/secrets.js");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  secretsRoutes(app);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const FAKE = "S06_FAKE_VALUE_ABC123";

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text || "{}"), text };
}

test("GET /api/secrets returns an empty vars object for a missing file", async () => {
  const { status, data } = await req("GET", "/api/secrets");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.vars, {});
});

test("POST /api/secrets writes vars, updates process env, and answers with masked values only", async () => {
  const { status, data, text } = await req("POST", "/api/secrets", {
    vars: { TEST_KEY_A: FAKE, TEST_KEY_B: "value-b" },
  });
  assert.equal(status, 200);
  assert.equal(data.vars.TEST_KEY_A, "••••••••", "values must be masked in the response");
  assert.equal(data.vars.TEST_KEY_B, "••••••••");
  assert.ok(!text.includes(FAKE), "response body must never contain the plaintext value");
  assert.equal(process.env.TEST_KEY_A, FAKE, "route must update the running process env");

  const content = readFileSync(process.env.SECRETS_ENV_PATH, "utf-8");
  assert.ok(content.includes(`export TEST_KEY_A='${FAKE}'`));
  assert.ok(content.includes("export TEST_KEY_B='value-b'"));
});

test("GET /api/secrets returns masked values and never plaintext", async () => {
  const { status, data, text } = await req("GET", "/api/secrets");
  assert.equal(status, 200);
  assert.ok(data.vars.TEST_KEY_A, "key written earlier must be listed");
  for (const value of Object.values(data.vars)) {
    assert.equal(value, "••••••••");
  }
  assert.ok(!text.includes(FAKE), "GET body must never contain the plaintext value");
});

test("POST without a key keeps its original value (leave-blank-to-keep)", async () => {
  const { status } = await req("POST", "/api/secrets", { vars: { TEST_KEY_B: "changed-b" } });
  assert.equal(status, 200);
  const content = readFileSync(process.env.SECRETS_ENV_PATH, "utf-8");
  assert.ok(content.includes(`export TEST_KEY_A='${FAKE}'`), "untouched key must keep its original value");
  assert.ok(content.includes("export TEST_KEY_B='changed-b'"), "submitted key must be updated");
});

test("POST rejects the literal mask so a round-trip cannot destroy the real secret", async () => {
  const before = readFileSync(process.env.SECRETS_ENV_PATH, "utf-8");
  const { status, text } = await req("POST", "/api/secrets", { vars: { TEST_KEY_B: "••••••••" } });
  assert.equal(status, 400);
  assert.ok(text.includes("掩码"), "error must explain the mask placeholder");
  assert.equal(readFileSync(process.env.SECRETS_ENV_PATH, "utf-8"), before, "file must be untouched");
});

test("POST with empty value deletes a key and rejects invalid names", async () => {
  const del = await req("POST", "/api/secrets", { vars: { TEST_KEY_A: "" } });
  assert.equal(del.status, 200);
  assert.equal(del.data.vars.TEST_KEY_A, undefined);
  assert.ok(!readFileSync(process.env.SECRETS_ENV_PATH, "utf-8").includes("TEST_KEY_A"));

  const bad = await req("POST", "/api/secrets", { vars: { "NOT VALID": "x" } });
  assert.equal(bad.status, 400);
});

test("cleanup process env", () => {
  delete process.env.TEST_KEY_A;
  delete process.env.TEST_KEY_B;
});
test("值里的内部换行被拒绝，首尾换行被容忍（2026-09-30）", async () => {
  // 内部换行会让写出的文件行脱离 EXPORT_RE 解析：该键之后既不进掩码快照
  // 也不被启动加载，删除它还会留下悬空引号让 source 报错
  const multiline = await req("POST", "/api/secrets", { vars: { TEST_KEY_ML: "line1\nline2" } });
  assert.equal(multiline.status, 400, "内部换行必须被拒绝");
  assert.ok(multiline.data.error.includes("换行"), multiline.data.error);
  assert.equal(multiline.data.error.includes("••••"), false);

  // 粘贴常带的尾换行不是错误：trim 后正常写入
  const pasted = await req("POST", "/api/secrets", { vars: { TEST_KEY_ML: "  pasted-value-123\n" } });
  assert.equal(pasted.status, 200, JSON.stringify(pasted.data));

  const file = readFileSync(process.env.SECRETS_ENV_PATH, "utf8");
  const line = file.split("\n").find((l) => l.includes("TEST_KEY_ML"));
  assert.equal(line, "export TEST_KEY_ML='pasted-value-123'", "写入必须是可被单行解析的一行");
  assert.equal(file.includes("pasted-value-123"), true, "本端点把掩码返回给浏览器，明文只应落在 0600 文件里");

  // 回读必须仍然看得见这个键（曾经的失败模式：写完即隐身）
  const after = await req("GET", "/api/secrets");
  assert.equal(after.data.vars.TEST_KEY_ML, "••••••••");
  assert.equal(JSON.stringify(after.data).includes("pasted-value-123"), false, "响应仍不得含明文");

  const removed = await req("POST", "/api/secrets", { vars: { TEST_KEY_ML: "" } });
  assert.equal(removed.status, 200);
  const afterRemove = readFileSync(process.env.SECRETS_ENV_PATH, "utf8");
  assert.equal(afterRemove.includes("TEST_KEY_ML"), false);
  // 曾经的失败模式：只删掉跨行值的首行，剩下的续行和收尾引号让 source 直接报错。
  // 这里逐行检查引号配平，确保文件仍是"一行一条"的可解析形态。
  for (const line of afterRemove.split("\n")) {
    const quotes = (line.match(/'/g) || []).length;
    assert.equal(quotes % 2, 0, `引号不配平，source 会失败: ${JSON.stringify(line)}`);
  }
  delete process.env.TEST_KEY_ML;
});
