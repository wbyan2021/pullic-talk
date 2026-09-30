import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  getManagedSecretNames,
  loadSecretsIntoProcess,
  registerManagedSecretNames,
  scrubManagedSecrets,
} from "../src/utils/secrets-env.js";
import { createPiExecutor } from "../src/services/pi-executor.js";
import { createValidationRunner } from "../src/services/validation-runner.js";

// 只在测试里存在的假键名/假值：绝不代表任何真实凭据
const KEYRING_KEY = "ZZ_FAKE_KEYRING_SECRET";
const USER_EXPORTED = "ZZ_USER_EXPORTED_VAR";

function fakeBoundary(repoRoot) {
  return {
    async getStatus() {
      return { active: { id: "project_env_scope", repoRoot, stale: false }, activeProjectId: "project_env_scope" };
    },
  };
}

test("scrubManagedSecrets 只剥 Keyring，保留用户显式导出的变量", () => {
  registerManagedSecretNames([KEYRING_KEY]);
  const { env, removed } = scrubManagedSecrets({
    [KEYRING_KEY]: "fake-value",
    [USER_EXPORTED]: "keep-me",
    PATH: "/usr/bin",
  });
  assert.equal(removed, 1);
  assert.ok(!(KEYRING_KEY in env), "Keyring 键必须被剥掉");
  assert.equal(env[USER_EXPORTED], "keep-me", "启动命令显式导出的变量不受影响");
  assert.equal(env.PATH, "/usr/bin", "基础环境必须保留，否则任何 CLI 都跑不起来");
  assert.equal(process.env[KEYRING_KEY], undefined, "scrub 不得改动调用方传进来的对象之外的东西");
});

test("启动加载登记键名，不接触值", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "keyring-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, ".secrets.env");
  writeFileSync(file, `export ${KEYRING_KEY}='fake-value'\nexport ZZ_SECOND_KEY='second'\n`, { mode: 0o600 });

  const target = {};
  const result = loadSecretsIntoProcess(file, target);
  assert.equal(result.loaded, 2);
  const names = getManagedSecretNames();
  assert.ok(names.includes(KEYRING_KEY) && names.includes("ZZ_SECOND_KEY"), "加载过的键必须进入集合");
  assert.ok(!names.some((n) => n.includes("fake-value") || n.includes("second")), "集合里只允许键名");
});

test("验收命令的子进程拿不到 Keyring", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "validation-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const observed = [];
  const spawnImpl = (_executable, _args, options) => {
    observed.push(options);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => child.emit("close", 0));
    return child;
  };

  process.env[KEYRING_KEY] = "fake-value";
  t.after(() => { delete process.env[KEYRING_KEY]; });

  const runner = createValidationRunner({ projectBoundary: fakeBoundary(dir), spawnImpl });
  const result = await runner.run({ executable: "npm", args: ["test"], approvedByUser: true });

  assert.equal(result.result, "passed");
  assert.equal(observed.length, 1);
  assert.ok(!(KEYRING_KEY in observed[0].env), "活动项目里执行的命令不得带走 Keyring");
  assert.ok(observed[0].env.PATH, "PATH 必须留给包管理器与测试框架");
  assert.equal(observed[0].shell, false, "shell=false 不能被放宽");
});

test("项目内的 Pi 子进程实际环境里没有 Keyring（端到端假 CLI）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-env-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  mkdirSync(project);
  const dump = join(dir, "env.dump");

  // 假 pi：auth 报就绪；真跑任务时把自己的完整环境写进 dump 文件
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi\nenv > "${dump}"\nexit 0\n`);
  chmodSync(bin, 0o755);

  registerManagedSecretNames([KEYRING_KEY]);
  process.env[KEYRING_KEY] = "fake-value";
  process.env[USER_EXPORTED] = "keep-me";
  t.after(() => {
    delete process.env[KEYRING_KEY];
    delete process.env[USER_EXPORTED];
  });

  const executor = createPiExecutor({ projectBoundary: fakeBoundary(project), piBinary: bin });
  await executor.start("做一条受控任务");

  const deadline = Date.now() + 8000;
  let childEnv = "";
  while (Date.now() < deadline) {
    try {
      childEnv = readFileSync(dump, "utf8");
      if (childEnv.length > 0) break;
    } catch { /* 还没写出来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(childEnv.length > 0, "假 pi 必须真的跑起来并留下环境快照");
  assert.ok(!childEnv.includes(`${KEYRING_KEY}=`), "Pi 子进程环境不得含 Keyring 键");
  assert.ok(childEnv.includes(`${USER_EXPORTED}=keep-me`), "用户显式导出的变量必须保留");
  assert.ok(childEnv.includes("PATH="), "PATH 必须保留");
});
