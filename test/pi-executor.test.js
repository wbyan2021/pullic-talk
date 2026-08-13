import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPiExecutor, PiExecutorError } from "../src/services/pi-executor.js";
import { activeProcs } from "../src/utils/process-registry.js";

// ── fixture helpers（只在 os.tmpdir() 内创建；绝不调用真实 pi） ──

function makeTmpDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `s03-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeFakePi(t, scriptBody, name = "pi") {
  const dir = makeTmpDir(t, "bin");
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${scriptBody}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

// 成功 pi：auth 就绪；运行时以 NDJSON text_delta 流式输出（同真实 pi --mode json）后退出 0
const SUCCESS_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"ready","provider":"test-provider","authType":"api_key"}'; exit 0; fi
printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"CWD:%s"}}\n' "$(pwd)"
printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"TASK:%s"}}\n' "$2"
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"chunk-1"}}'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"chunk-2"}}'
echo '{"type":"agent_end"}'
exit 0
`;

// argvdump pi：把运行参数写入 $DUMP 文件（路径烘焙进脚本）
function argvDumpScript(dumpPath) {
  return `
if [ "$1" = "auth" ]; then printf '%s\\n' "$@" > "${dumpPath}"; echo '{"status":"ready"}'; exit 0; fi
printf '%s\\n' "$@" > "${dumpPath}"
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"ok"}}'
exit 0
`;
}

// 慢 pi：auth 就绪后 sleep（用于 stop / timeout；exec 让 SIGTERM 直达，不留孤儿）
const SLOW_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
exec sleep 30
`;

// auth 失败 pi
const AUTH_FAIL_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"not_ready","provider":"test-provider","reason":"credentials_not_configured"}'; exit 0; fi
echo should-not-run
exit 0
`;

// 非零退出 pi（stderr 不得外泄）
const FAIL_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
echo "secret-internal-detail" 1>&2
exit 3
`;

// 大输出 pi（NDJSON text_delta）
const LOUD_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
i=0
while [ $i -lt 50 ]; do
  printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"line-%s-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}\n' "$i"
  i=$((i+1))
done
exit 0
`;

// 噪声 pi：thinking_delta 与非 JSON 行不得进入输出流
const NOISY_PI = `
if [ "$1" = "auth" ]; then echo '{"status":"ready"}'; exit 0; fi
echo '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"SECRET-THINKING"}}'
echo 'not-a-json-line'
echo '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"visible-text"}}'
exit 0
`;

function makeBoundary({ repoRoot = "/tmp/unused", stale = false, active = true } = {}) {
  return {
    async getStatus() {
      if (!active) return { projects: [], activeProjectId: null, active: null };
      const payload = {
        id: "abc123def456",
        inputPath: repoRoot,
        resolvedPath: repoRoot,
        repoRoot,
        selectedAt: "2026-08-12T00:00:00.000Z",
        stale,
        inspection: {},
        selectionSnapshotAt: "2026-08-12T00:00:00.000Z",
      };
      return { projects: [payload], activeProjectId: payload.id, active: payload };
    },
  };
}

function collect(executor) {
  const events = [];
  const unsubscribe = executor.subscribe((type, data) => events.push({ type, data }));
  return { events, unsubscribe };
}

async function waitDone(events, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = events.find((e) => e.type === "done");
    if (done) return done;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`no done event within ${timeoutMs}ms; got ${JSON.stringify(events.map((e) => e.type))}`);
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(
      error instanceof PiExecutorError,
      `expected PiExecutorError, got ${error?.constructor?.name}: ${error?.message}`
    );
    return error.code;
  }
  assert.fail("expected rejection");
}

// ── auth 检查（D7） ──

test("checkAuth happy path passes --provider and parses status", async (t) => {
  const dumpDir = makeTmpDir(t, "authdump");
  const dumpPath = join(dumpDir, "auth-argv.txt");
  const pi = makeFakePi(t, argvDumpScript(dumpPath));
  const executor = createPiExecutor({
    projectBoundary: makeBoundary({}),
    piBinary: pi,
    authProvider: "test-provider",
  });

  const result = await executor.checkAuth();
  assert.equal(result.ready, true);

  const argv = readFileSync(dumpPath, "utf8").trim().split("\n");
  assert.deepEqual(argv, ["auth", "check", "--provider", "test-provider", "--json"]);
  assert.ok(!argv.includes("--api-key"), "auth check must never pass --api-key");
});

test("checkAuth provider resolution: PI_AUTH_PROVIDER env wins over PI_PROVIDER and google fallback", async (t) => {
  const dumpDir = makeTmpDir(t, "authdump2");
  const dumpPath = join(dumpDir, "auth-argv.txt");
  const pi = makeFakePi(t, argvDumpScript(dumpPath));

  const saved = { a: process.env.PI_AUTH_PROVIDER, p: process.env.PI_PROVIDER };
  try {
    process.env.PI_AUTH_PROVIDER = "env-provider-a";
    process.env.PI_PROVIDER = "env-provider-p";
    let executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: pi });
    await executor.checkAuth();
    assert.ok(readFileSync(dumpPath, "utf8").includes("env-provider-a"));

    delete process.env.PI_AUTH_PROVIDER;
    executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: pi });
    await executor.checkAuth();
    assert.ok(readFileSync(dumpPath, "utf8").includes("env-provider-p"));

    delete process.env.PI_PROVIDER;
    executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: pi });
    await executor.checkAuth();
    assert.ok(readFileSync(dumpPath, "utf8").includes("google"));
  } finally {
    if (saved.a === undefined) delete process.env.PI_AUTH_PROVIDER; else process.env.PI_AUTH_PROVIDER = saved.a;
    if (saved.p === undefined) delete process.env.PI_PROVIDER; else process.env.PI_PROVIDER = saved.p;
  }
});

test("checkAuth not_ready reports pi_not_authenticated; missing binary reports pi_not_found", async (t) => {
  const authFail = makeFakePi(t, AUTH_FAIL_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: authFail, authProvider: "test-provider" });
  const notReady = await executor.checkAuth();
  assert.equal(notReady.ready, false);
  assert.equal(notReady.code, "pi_not_authenticated");

  const missing = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: "/nonexistent/pi-xyz" });
  const notFound = await missing.checkAuth();
  assert.equal(notFound.ready, false);
  assert.equal(notFound.code, "pi_not_found");
});

// ── 成功运行与流式 ──

test("start runs pi in active project cwd and streams chunks to done/exited", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SUCCESS_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  const runId = await executor.start("列出当前目录的文件");
  assert.ok(runId);
  const done = await waitDone(events);
  unsubscribe();

  assert.equal(done.data.state, "exited");
  assert.equal(done.data.exitCode, 0);
  assert.equal(done.data.truncated, false);
  assert.ok(done.data.durationMs >= 0);

  const types = events.map((e) => e.type);
  assert.equal(types[0], "start");
  assert.ok(types.includes("chunk"));
  const output = events.filter((e) => e.type === "chunk").map((e) => e.data.text).join("");
  // macOS 临时目录带 /var → /private/var 符号链接；pwd 返回 realpath
  const realRoot = realpathSync(repoRoot);
  assert.ok(output.includes(`CWD:${realRoot}`) || output.includes(`CWD:${repoRoot}`), "pi must run inside the active project repoRoot");
  assert.ok(output.includes("TASK:列出当前目录的文件"));
  assert.ok(output.includes("chunk-1") && output.includes("chunk-2"));

  const status = executor.getStatus();
  assert.equal(status.state, "exited");
  assert.equal(status.runId, runId);
  assert.equal(status.exitCode, 0);
});

test("argv contains exactly -p <task> --no-session and never --api-key", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const dumpDir = makeTmpDir(t, "argvdump");
  const dumpPath = join(dumpDir, "argv.txt");
  const pi = makeFakePi(t, argvDumpScript(dumpPath));
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start('task with spaces and "quotes"');
  await waitDone(events);
  unsubscribe();

  const argv = readFileSync(dumpPath, "utf8").split("\n").filter((l) => l.length > 0);
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], 'task with spaces and "quotes"', "task must be one single argument");
  assert.equal(argv[2], "--no-session");
  assert.equal(argv[3], "--mode");
  assert.equal(argv[4], "json", "D10: json mode is required for streaming output");
  assert.equal(argv.length, 5);
  assert.ok(!argv.includes("--api-key"), "--api-key must never be passed");
});

// ── 停止与超时 ──

test("stop terminates a running pi with state stopped; stop when idle is a no-op", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SLOW_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start("slow task");
  await new Promise((r) => setTimeout(r, 300)); // 确保进程已起来
  const stoppedStatus = executor.stop();
  assert.equal(stoppedStatus.state, "stopping");

  const done = await waitDone(events);
  unsubscribe();
  assert.equal(done.data.state, "stopped");

  const idle = executor.stop(); // 已停止后再 stop：无操作、不抛错
  assert.equal(idle.state, "stopped");
});

test("timeout kills the run and reports lastError timeout", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SLOW_PI);
  const executor = createPiExecutor({
    projectBoundary: makeBoundary({ repoRoot }),
    piBinary: pi,
    authProvider: "test-provider",
    timeoutMs: 300,
    killGraceMs: 200,
  });
  const { events, unsubscribe } = collect(executor);

  await executor.start("never finishes");
  const done = await waitDone(events);
  unsubscribe();
  assert.equal(done.data.state, "error");
  const status = executor.getStatus();
  assert.equal(status.lastError.code, "timeout");
  assert.equal(status.lastError.retryable, true);
});

// ── 并发与输入边界 ──

test("second start while running rejects busy", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SLOW_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start("first");
  assert.equal(await rejectCode(executor.start("second")), "busy");
  executor.stop();
  await waitDone(events);
  unsubscribe();
});

test("invalid tasks reject invalid_task", async (t) => {
  const executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: "/nonexistent/pi-xyz" });
  for (const task of ["", "   ", "x".repeat(4001), "a\u0000b", 123, null]) {
    assert.equal(await rejectCode(executor.start(task)), "invalid_task");
  }
});

// ── 项目边界（D8：活动项目） ──

test("start without active project rejects no_project_selected; stale active rejects project_stale", async (t) => {
  const pi = makeFakePi(t, SUCCESS_PI);

  const none = createPiExecutor({ projectBoundary: makeBoundary({ active: false }), piBinary: pi, authProvider: "test-provider" });
  assert.equal(await rejectCode(none.start("task")), "no_project_selected");

  const stale = createPiExecutor({ projectBoundary: makeBoundary({ stale: true }), piBinary: pi, authProvider: "test-provider" });
  assert.equal(await rejectCode(stale.start("task")), "project_stale");
});

test("start with missing pi binary rejects pi_not_found; auth not ready rejects pi_not_authenticated", async (t) => {
  const missing = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: "/nonexistent/pi-xyz" });
  assert.equal(await rejectCode(missing.start("task")), "pi_not_found");

  const authFail = makeFakePi(t, AUTH_FAIL_PI);
  const notAuthed = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: authFail, authProvider: "test-provider" });
  assert.equal(await rejectCode(notAuthed.start("task")), "pi_not_authenticated");
});

// ── 输出与错误边界 ──

test("only text_delta content is streamed; thinking and non-JSON lines are dropped", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, NOISY_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start("noisy");
  await waitDone(events);
  unsubscribe();
  const output = events.filter((e) => e.type === "chunk").map((e) => e.data.text).join("");
  assert.equal(output, "visible-text");
  assert.ok(!JSON.stringify(executor.getStatus()).includes("SECRET-THINKING"));
});

test("output beyond limit is truncated and flagged", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, LOUD_PI);
  const executor = createPiExecutor({
    projectBoundary: makeBoundary({ repoRoot }),
    piBinary: pi,
    authProvider: "test-provider",
    outputLimit: 64,
  });
  const { events, unsubscribe } = collect(executor);

  await executor.start("loud");
  const done = await waitDone(events);
  unsubscribe();
  assert.equal(done.data.truncated, true);
  const status = executor.getStatus();
  assert.ok(Buffer.byteLength(status.output) <= 64);
  assert.equal(status.truncated, true);
});

test("non-zero exit ends in error state; stderr never leaks into events or messages", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, FAIL_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start("will fail");
  const done = await waitDone(events);
  unsubscribe();
  assert.equal(done.data.state, "error");
  assert.equal(done.data.exitCode, 3);

  const serialized = JSON.stringify(events) + JSON.stringify(executor.getStatus());
  assert.ok(!serialized.includes("secret-internal-detail"), "stderr must never leak");
});

// ── 进程注册与回放 ──

test("running process is registered in activeProcs and removed after close", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SLOW_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  const before = activeProcs.size;
  await executor.start("register me");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(activeProcs.size, before + 1, "running pi must be tracked for shutdown cleanup");

  executor.stop();
  await waitDone(events);
  unsubscribe();
  assert.equal(activeProcs.size, before, "proc must be deregistered after close");
});

test("late subscriber receives the buffered replay of the last run", async (t) => {
  const repoRoot = makeTmpDir(t, "repo");
  const pi = makeFakePi(t, SUCCESS_PI);
  const executor = createPiExecutor({ projectBoundary: makeBoundary({ repoRoot }), piBinary: pi, authProvider: "test-provider" });
  const { events, unsubscribe } = collect(executor);

  await executor.start("replay me");
  await waitDone(events);
  unsubscribe();

  const replay = [];
  const unsub2 = executor.subscribe((type, data) => replay.push({ type, data }));
  unsub2();
  const types = replay.map((e) => e.type);
  assert.equal(types[0], "start");
  assert.ok(types.includes("chunk"));
  assert.equal(types[types.length - 1], "done");
});

test("idle status reports state idle with no run", () => {
  const executor = createPiExecutor({ projectBoundary: makeBoundary({}), piBinary: "/nonexistent/pi-xyz" });
  const status = executor.getStatus();
  assert.equal(status.state, "idle");
  assert.equal(status.runId, null);
});
