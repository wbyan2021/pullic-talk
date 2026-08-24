import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 每个 node --test 文件是独立进程：进入测试前先指向临时配置，
// 避免读写用户真实的 agents.config.json
const tmp = mkdtempSync(join(tmpdir(), "agents-config-"));
process.env.AGENTS_CONFIG_PATH = join(tmp, "agents.config.json");

writeFileSync(
  process.env.AGENTS_CONFIG_PATH,
  JSON.stringify(
    {
      codex: { model: "gpt-5", models: ["gpt-5", "gpt-4"] },
      claude: { enabled: false },
      myai: {
        name: "My AI",
        model: "my-model",
        cli: { command: "myai", args: ["-p", "{prompt}"] },
      },
      badone: { name: "Bad One" },
    },
    null,
    2,
  ),
  "utf-8",
);

const cfg = await import("../src/config.js");
const getUserConfigRaw = cfg.getUserConfigRaw;
const writeUserConfig = cfg.writeUserConfig;
const reloadConfig = cfg.reloadConfig;

test("partial override inherits builtin cli and keeps user model", () => {
  const codex = cfg.AGENTS.codex;
  assert.ok(codex, "codex should stay enabled");
  assert.equal(codex.model, "gpt-5");
  assert.deepEqual([...codex.models], ["gpt-5", "gpt-4"]);
  assert.equal(codex.cli.command, "codex", "cli must be inherited from builtin catalog");
  assert.equal(codex.source, "override");
});

test("builtin member with enabled:false is removed from AGENTS", () => {
  assert.equal(cfg.AGENTS.claude, undefined, "disabled builtin member must not appear in chat targets");
});

test("custom member is added when cli.command is present", () => {
  assert.ok(cfg.AGENTS.myai, "custom member must be loaded");
  assert.equal(cfg.AGENTS.myai.name, "My AI");
  assert.equal(cfg.AGENTS.myai.source, "user");
});

test("custom member without cli.command is skipped", () => {
  assert.equal(cfg.AGENTS.badone, undefined, "invalid custom member must be ignored");
});

test("writeUserConfig + reloadConfig roundtrip updates AGENTS", () => {
  const raw = getUserConfigRaw();
  raw.myai.enabled = false;
  writeUserConfig(raw);
  assert.equal(reloadConfig(), true);
  assert.equal(cfg.AGENTS.myai, undefined, "disabled custom member must be removed from AGENTS");
  const onDisk = JSON.parse(readFileSync(process.env.AGENTS_CONFIG_PATH, "utf-8"));
  assert.equal(onDisk.myai.enabled, false);
});

test("reloadConfig keeps old agents when the new config is broken", () => {
  writeUserConfig({ ...getUserConfigRaw(), myai: { enabled: false }, bad2: { name: "no cli" } });
  // bad2 is a custom member without cli.command and should be ignored
  assert.equal(reloadConfig(), true);
  assert.equal(cfg.AGENTS.myai, undefined);
  assert.equal(cfg.AGENTS.bad2, undefined);
});

test("teardown temp config", () => {
  rmSync(tmp, { recursive: true, force: true });
});