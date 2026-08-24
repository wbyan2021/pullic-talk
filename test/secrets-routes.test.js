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

async function req(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

test("GET /api/secrets returns an empty vars object for a missing file", async () => {
  const { status, data } = await req("GET", "/api/secrets");
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.vars, {});
});

test("POST /api/secrets writes vars and updates process env", async () => {
  const { status, data } = await req("POST", "/api/secrets", {
    vars: { TEST_KEY_A: "value-a", TEST_KEY_B: "value-b" },
  });
  assert.equal(status, 200);
  assert.equal(data.vars.TEST_KEY_A, "value-a");
  assert.equal(process.env.TEST_KEY_A, "value-a", "route must update the running process env");

  const content = readFileSync(process.env.SECRETS_ENV_PATH, "utf-8");
  assert.ok(content.includes("export TEST_KEY_A='value-a'"));
  assert.ok(content.includes("export TEST_KEY_B='value-b'"));
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