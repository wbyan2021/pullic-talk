import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AiHandoffError,
  createAiHandoff,
} from "../src/services/ai-handoff.js";

function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "s04-handoff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseInput(repoRoot, taskId = "task_001") {
  return {
    repoRoot,
    taskId,
    taskStatus: "needs_review",
    plan: { source: "docs/NOW.md", revision: "v0.1-r1", completed: 4, total: 6, percent: 66.7 },
    before: { branch: "main", head: "abc1234", worktree: "modified" },
    after: { branch: "codex/s04", head: "def5678", changedPaths: ["src/app.js"] },
    evidence: { execution: "verified", git: "verified", validation: "not_run" },
    facts: {
      verified: ["npm test was not run"],
      user_confirmed: ["保留 Pi 受控运行"],
      agent_reported: ["API_KEY=sk-test-12345678901234567890"],
      recorded_not_reverified: [],
      unknown: ["并发改动无法归因"],
    },
    issuesAndRisks: ["stderr=secret-internal"],
    nextAction: "先完成验收命令",
  };
}

async function rejectCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AiHandoffError);
    return error.code;
  }
  assert.fail("expected rejection");
}

test("writes deterministic current and one-time history files atomically and redacts content", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });
  const input = baseInput(repoRoot);
  const record = await writer.writeRecord(input);
  assert.equal(record.status, "written");
  assert.ok(existsSync(join(repoRoot, "docs/ai-ops/records/task_001.md")));
  assert.equal(await rejectCode(writer.writeRecord(input)), "record_exists");

  const current = await writer.writeCurrent(input);
  assert.equal(current.status, "written");
  const raw = readFileSync(join(repoRoot, "docs/ai-ops/NOW.md"), "utf8");
  assert.ok(raw.includes("type: ai-handoff-current"));
  assert.ok(raw.includes("task_status: needs_review"));
  assert.ok(raw.includes("next_action: 先完成验收命令"));
  assert.ok(raw.includes("[withheld_sensitive]"));
  assert.ok(!raw.includes("sk-test-12345678901234567890"));
  assert.ok(!raw.includes("secret-internal"));
});

test("preserves non-managed files and requires explicit AGENTS pointer permission", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff();
  const input = baseInput(repoRoot);
  const nowPath = join(repoRoot, "docs/ai-ops/NOW.md");
  const agentsPath = join(repoRoot, "AGENTS.md");
  // Create the directory and a user-owned handoff file.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(repoRoot, "docs/ai-ops"), { recursive: true });
  writeFileSync(nowPath, "user-owned now\n");
  assert.equal(await rejectCode(writer.writeCurrent(input)), "handoff_conflict");
  assert.equal(readFileSync(nowPath, "utf8"), "user-owned now\n");

  writeFileSync(agentsPath, "# Existing instructions\n");
  rmSync(nowPath);
  assert.equal(await rejectCode(writer.enableProject({ repoRoot })), "agents_pointer_confirmation_required");
  const enabled = await writer.enableProject({ repoRoot, allowAgentsPointer: true });
  assert.equal(enabled.status, "enabled");
  const agents = readFileSync(agentsPath, "utf8");
  assert.ok(agents.startsWith("# Existing instructions"));
  assert.ok(agents.includes("AI-OPS-COCKPIT:BEGIN"));
  assert.ok(agents.includes("docs/ai-ops/NOW.md"));
});

test("creates a bounded managed pointer only after explicit enablement", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });
  const enabled = await writer.enableProject({ repoRoot, allowAgentsPointer: true });
  assert.deepEqual(enabled.paths, { current: "docs/ai-ops/NOW.md", records: "docs/ai-ops/records" });
  assert.ok(existsSync(join(repoRoot, "AGENTS.md")));
  assert.ok(readFileSync(join(repoRoot, "AGENTS.md"), "utf8").length < 1000);
});

test("inspects the actual handoff file state without returning file contents", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff();

  assert.deepEqual(await writer.inspectProject({ repoRoot }), {
    agentsPointer: "missing",
    current: "missing",
    records: "missing",
    state: "not_enabled",
  });
});

test("explicit enablement initializes a safe current handoff and records directory", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });

  await writer.enableProject({ repoRoot, allowAgentsPointer: true });

  const currentPath = join(repoRoot, "docs/ai-ops/NOW.md");
  assert.ok(existsSync(currentPath));
  assert.ok(existsSync(join(repoRoot, "docs/ai-ops/records")));
  const raw = readFileSync(currentPath, "utf8");
  assert.ok(raw.includes("type: ai-handoff-current"));
  assert.ok(raw.includes("task_status: needs_review"));
  assert.ok(raw.includes("unknown:"));
  assert.ok(raw.includes("next_action: 读取当前项目规划来源并确认唯一下一步"));
  assert.deepEqual(await writer.inspectProject({ repoRoot }), {
    agentsPointer: "managed",
    current: "managed",
    records: "present",
    state: "ready",
  });
});

test("repair preserves an existing managed current handoff", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });
  await writer.writeCurrent(baseInput(repoRoot));
  const before = readFileSync(join(repoRoot, "docs/ai-ops/NOW.md"), "utf8");

  await writer.enableProject({ repoRoot, allowAgentsPointer: true });

  assert.equal(readFileSync(join(repoRoot, "docs/ai-ops/NOW.md"), "utf8"), before);
  assert.equal((await writer.inspectProject({ repoRoot })).state, "ready");
});

test("repair refuses to overwrite an existing non-managed current handoff", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff();
  const { mkdirSync } = await import("node:fs");
  const currentPath = join(repoRoot, "docs/ai-ops/NOW.md");
  mkdirSync(join(repoRoot, "docs/ai-ops"), { recursive: true });
  writeFileSync(currentPath, "user-owned now\n");

  assert.equal(
    await rejectCode(writer.enableProject({ repoRoot, allowAgentsPointer: true })),
    "handoff_conflict"
  );
  assert.equal(readFileSync(currentPath, "utf8"), "user-owned now\n");
});

test("reads only a bounded safe summary from the managed current handoff", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });
  await writer.writeCurrent({ ...baseInput(repoRoot), nextAction: "先运行验收测试" });

  const summary = await writer.readSummary({ repoRoot });

  assert.deepEqual(summary, {
    state: "ready",
    taskStatus: "needs_review",
    nextAction: "先运行验收测试",
  });
});

test("returns an unavailable summary for missing, conflicting, malformed, or overlong handoff files", async (t) => {
  const cases = [
    { name: "missing", content: null },
    { name: "conflicting", content: "user-owned now\n" },
    { name: "malformed", content: "<!-- ai-ops-managed:v1 -->\n---\ntype: ai-handoff-current\n---\n" },
    {
      name: "overlong",
      content: `<!-- ai-ops-managed:v1 -->\n---\ntype: ai-handoff-current\ntask_status: in_progress\nnext_action: ${"x".repeat(301)}\n---\n`,
    },
  ];

  for (const item of cases) {
    const repoRoot = makeRoot(t);
    const currentPath = join(repoRoot, "docs/ai-ops/NOW.md");
    if (item.content !== null) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(repoRoot, "docs/ai-ops"), { recursive: true });
      writeFileSync(currentPath, item.content);
    }
    const summary = await createAiHandoff().readSummary({ repoRoot });
    assert.deepEqual(summary, {
      state: "unavailable",
      taskStatus: null,
      nextAction: null,
    }, item.name);
  }
});

test("readSummary never reads records or writes files", async (t) => {
  const repoRoot = makeRoot(t);
  const writer = createAiHandoff({ now: () => 1_750_000_000_000 });
  await writer.writeCurrent({ ...baseInput(repoRoot), nextAction: "检查 API_KEY=sk-test-12345678901234567890" });

  const accessed = [];
  const reader = createAiHandoff({
    fsImpl: {
      access: async (filePath) => { accessed.push(filePath); },
      readFile: async (filePath) => readFileSync(filePath, "utf8"),
      mkdir: async () => { throw new Error("readSummary must not write"); },
      writeFile: async () => { throw new Error("readSummary must not write"); },
      rename: async () => { throw new Error("readSummary must not write"); },
    },
  });

  const summary = await reader.readSummary({ repoRoot });

  assert.equal(summary.state, "ready");
  assert.equal(summary.nextAction, "[withheld_sensitive]");
  assert.ok(accessed.every((filePath) => !filePath.includes(`${join("docs", "ai-ops", "records")}`)));
});

// 写入失败时不得把 .tmp 留在用户仓库里：本产品自己会用 Git 快照统计未跟踪改动，
// 残留的临时文件会混进 changedPaths，污染它要交付的“文件变化证据”（2026-09-30 排查发现）。
test("发布失败时清理临时文件，不在目标项目里留下残骸", async (t) => {
  const root = makeRoot(t);
  const broken = createAiHandoff({
    fsImpl: { rename: async () => { throw Object.assign(new Error("cross-device"), { code: "EXDEV" }); } },
  });

  await assert.rejects(() => broken.writeCurrent(baseInput(root)), (error) => {
    assert.equal(error.code, "io_error");
    return true;
  });

  const nowPath = join(root, "docs", "ai-ops");
  const leftovers = existsSync(nowPath)
    ? readdirSync(nowPath).filter((name) => name.includes(".tmp-"))
    : [];
  assert.deepEqual(leftovers, [], "no *.tmp-* may survive a failed publish");
});

// 历史记录“不可覆盖”必须是发布动作本身的性质，不能只靠 exists() 预检——
// 预检与发布之间的窗口里并发写入会静默覆盖掉已有历史。
test("历史记录的发布是不可覆盖的：link 报 EEXIST 时拒绝而非盖掉", async (t) => {
  const root = makeRoot(t);
  const recordsDir = join(root, "docs", "ai-ops", "records");
  mkdirSync(recordsDir, { recursive: true });
  const sentinel = join(recordsDir, "task_race.md");
  writeFileSync(sentinel, "已有的历史记录，绝不能被覆盖\n", "utf8");

  let linked = false;
  const racing = createAiHandoff({
    fsImpl: {
      // 预检看到的是"不存在"，发布时才撞上另一个写入者
      access: async (filePath) => {
        if (filePath === sentinel && !linked) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return undefined;
      },
      link: async () => {
        linked = true;
        throw Object.assign(new Error("already exists"), { code: "EEXIST" });
      },
    },
  });

  const code = await rejectCode(racing.writeRecord(baseInput(root, "task_race")));
  assert.equal(code, "write_conflict");
  assert.equal(readFileSync(sentinel, "utf8"), "已有的历史记录，绝不能被覆盖\n");
  const leftovers = readdirSync(recordsDir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "失败的记录发布同样不得留下临时文件");
});
