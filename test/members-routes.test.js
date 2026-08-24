import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// 隔离配置：不碰用户真实的 agents.config.json
const tmp = mkdtempSync(join(tmpdir(), "agents-routes-"));
process.env.AGENTS_CONFIG_PATH = join(tmp, "agents.config.json");
writeFileSync(
  process.env.AGENTS_CONFIG_PATH,
  JSON.stringify({
    codex: { model: "gpt-4", models: ["gpt-4", "gpt-5"] },
  }),
  "utf-8",
);

const { default: express } = await import("express");
const { default: membersRoutes } = await import("../src/routes/members.js");
const cfg = await import("../src/config.js");

let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  membersRoutes(app);
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

test("GET /api/members lists builtin and user members including disabled", async () => {
  const { status, data } = await req("GET", "/api/members");
  assert.equal(status, 200);
  assert.ok(data.members.codex);
  assert.equal(data.members.codex.enabled, true);
  assert.equal(data.members.codex.model, "gpt-4");
  assert.deepEqual([...data.members.codex.models], ["gpt-4", "gpt-5"]);
  assert.ok(data.members.claude, "builtin catalog members are listed");
  assert.equal(data.members.claude.builtin, true);
});

test("PUT updates model and cli is inherited from builtin", async () => {
  const { status, data } = await req("PUT", "/api/members/codex", { model: "gpt-5" });
  assert.equal(status, 200);
  assert.equal(data.member.model, "gpt-5");
  assert.equal(cfg.AGENTS.codex.cli.command, "codex", "merge must keep builtin cli");
  const onDisk = JSON.parse(readFileSync(process.env.AGENTS_CONFIG_PATH, "utf-8"));
  assert.equal(onDisk.codex.model, "gpt-5");
  assert.equal(onDisk.codex.cli, undefined, "partial override must not duplicate cli");
});

test("PUT enabled:false disables a member", async () => {
  const { status } = await req("PUT", "/api/members/pi", { enabled: false });
  assert.equal(status, 200);
  assert.equal(cfg.AGENTS.pi, undefined);
  const { data } = await req("GET", "/api/members");
  assert.equal(data.members.pi.enabled, false);
});

test("POST adds a custom member and rejects duplicates", async () => {
  const { status, data } = await req("POST", "/api/members", {
    key: "myai",
    name: "My AI",
    model: "m1",
    models: ["m1", "m2"],
    cli: { command: "myai", args: ["-p", "{prompt}"], parseMode: "text" },
  });
  assert.equal(status, 200);
  assert.equal(data.member.source, "user");
  assert.equal(cfg.AGENTS.myai.name, "My AI");

  const dup = await req("POST", "/api/members", {
    key: "myai",
    name: "again",
    cli: { command: "myai" },
  });
  assert.equal(dup.status, 409);
});

test("DELETE removes a custom member and soft-disables a builtin one", async () => {
  const delCustom = await req("DELETE", "/api/members/myai");
  assert.equal(delCustom.status, 200);
  const cfg1 = JSON.parse(readFileSync(process.env.AGENTS_CONFIG_PATH, "utf-8"));
  assert.equal(cfg1.myai, undefined);

  const delBuiltin = await req("DELETE", "/api/members/codex");
  assert.equal(delBuiltin.status, 200);
  assert.equal(cfg.AGENTS.codex, undefined);
  const cfg2 = JSON.parse(readFileSync(process.env.AGENTS_CONFIG_PATH, "utf-8"));
  assert.equal(cfg2.codex.enabled, false);
});

test("validation rejects invalid key and malformed models", async () => {
  const badKey = await req("POST", "/api/members", { key: "BAD KEY", name: "x", cli: { command: "x" } });
  assert.equal(badKey.status, 400);

  const badModels = await req("PUT", "/api/members/codex", { models: ["ok", 123] });
  assert.equal(badModels.status, 400);
});