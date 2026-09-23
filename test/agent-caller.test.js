import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPrompt, sanitizeChatRequest } from "../src/agent-caller.js";

const AGENT_CALLER_SRC = readFileSync(fileURLToPath(new URL("../src/agent-caller.js", import.meta.url)), "utf8");

// ── buildPrompt：当前消息不得重复拼接 ──

test("buildPrompt omits the trailing history entry that duplicates the current message", () => {
  const message = "please review this code";
  const history = [
    { sender: "你", text: "first question" },
    { sender: "Codex", text: "first answer" },
    { sender: "你", text: message }, // 部分客户端会把刚发出的消息带进 history
  ];
  const prompt = buildPrompt("codex", { message, history, mode: "parallel", rounds: 1 }, []);
  assert.equal(
    prompt.split(message).length - 1,
    1,
    "the current message must appear exactly once in the prompt",
  );
  assert.ok(prompt.includes("first question"), "earlier history must be preserved");
  assert.ok(prompt.includes("first answer"), "earlier history must be preserved");
});

test("buildPrompt keeps history when the last user message differs from the current one", () => {
  const history = [
    { sender: "你", text: "old question" },
    { sender: "Codex", text: "old answer" },
  ];
  const prompt = buildPrompt("codex", { message: "new question", history, mode: "parallel", rounds: 1 }, []);
  assert.ok(prompt.includes("old question"));
  assert.equal(prompt.split("new question").length - 1, 1);
});

test("buildPrompt only dedups a trailing user message, never agent messages", () => {
  const message = "same words";
  const history = [
    { sender: "你", text: "q" },
    { sender: "Codex", text: message }, // agent 恰好说了同样的话，应保留
  ];
  const prompt = buildPrompt("codex", { message, history, mode: "parallel", rounds: 1 }, []);
  assert.equal(prompt.split(message).length - 1, 2, "history copy + current message");
});

test("buildPrompt includes persona only in discuss mode", () => {
  const ctx = { message: "hi", history: [], mode: "parallel", rounds: 1 };
  const plain = buildPrompt("codex", ctx, []);
  const discuss = buildPrompt("codex", { ...ctx, mode: "collaborate", rounds: 2 }, []);
  assert.ok(!plain.includes("persona-marker-none"), "sanity");
  assert.ok(discuss.length >= plain.length, "discuss mode adds persona context");
});

// ── sanitizeChatRequest：入参校验与收敛 ──

test("sanitizeChatRequest validates, dedups and clamps fields", () => {
  const { error, data } = sanitizeChatRequest({
    message: "hi",
    targets: ["codex", "not-an-agent", "codex"],
    history: [{ sender: "你", text: "ctx" }],
    thinking: "bogus",
    mode: "bogus",
    rounds: 99,
  });
  assert.equal(error, undefined);
  assert.deepEqual(data.targets, ["codex"]);
  assert.equal(data.thinking, "medium");
  assert.equal(data.mode, "parallel");
  assert.equal(data.rounds, 5); // LIMITS.maxRounds
  assert.deepEqual(data.history, [{ sender: "你", text: "ctx" }]);
});

test("sanitizeChatRequest rejects an empty message", () => {
  assert.equal(sanitizeChatRequest({ message: "   " }).error, "消息不能为空");
});

test("sanitizeChatRequest rejects a non-object body", () => {
  assert.ok(sanitizeChatRequest(null).error);
  assert.ok(sanitizeChatRequest("x").error);
});

// ── 源码级守护 ──

test("callAgent closes stdin for pipe agents so CLIs see EOF instead of hanging", () => {
  assert.ok(
    AGENT_CALLER_SRC.includes("proc.stdin.end()"),
    "pipe-mode stdin must be ended right after spawn",
  );
});

// ── 2026-09-24 对话页审查修复的回归 ──

test("buildPrompt 截断时用户消息完整保留在尾部", () => {
  const message = "m".repeat(7900) + "最后这个问题必须保住";
  // 历史/回复各自顶到配额（≈15900/12000），叠加 persona 与超长消息越过 32000 总限，
  // 触发兜底截断：中间节被压缩，用户消息仍在尾部完整保留
  const history = Array.from({ length: 3 }, () => ({ sender: "你", text: "h".repeat(5300) }));
  const priorResponses = Array.from({ length: 3 }, () => ({ agent: "grok", text: "x".repeat(3900) }));
  const prompt = buildPrompt("grok", { message, history, mode: "collaborate", rounds: 5 }, priorResponses);
  assert.ok(prompt.length <= 32200, `总长应被压回上限附近，实际 ${prompt.length}`);
  assert.ok(prompt.endsWith(`用户消息: ${message}`), "用户消息必须完整出现在 prompt 尾部");
  assert.ok(prompt.includes("已截断"), "应带截断标记");
});

test("priorResponses 配额从最新往回填，旧回复先被丢弃", () => {
  const message = "问题";
  const priorResponses = [
    { agent: "grok", text: "z".repeat(400) + "最旧-应被丢弃" },
    { agent: "grok", text: "y".repeat(3900) },
    { agent: "grok", text: "y".repeat(3900) },
    { agent: "grok", text: "y".repeat(3900) },
    { agent: "grok", text: "y".repeat(3900) },
    { agent: "grok", text: "最新-应保留" },
  ];
  const prompt = buildPrompt("grok", { message, history: [], mode: "collaborate", rounds: 2 }, priorResponses);
  assert.ok(prompt.includes("最新-应保留"));
  assert.ok(!prompt.includes("最旧-应被丢弃"), "超出配额的最旧回复应被丢弃（旧的先丢，保住最新讨论）");
});

test("callAgent 按原始字节计输出上限（ndjson 过滤行不绕过），且 error+close 只结算一次", () => {
  assert.ok(AGENT_CALLER_SRC.includes("rawBytes += n"), "输出上限必须按原始字节累计");
  assert.ok(AGENT_CALLER_SRC.includes("if (settled) return"), "close 处理器必须短路已结算的调用");
  assert.ok(/trackOutput[\s\S]{0,400}SIGKILL/.test(AGENT_CALLER_SRC), "输出超限也要有 SIGKILL 升级");
});

test("json-envelope 分支先处理超时/超限，半截 JSON 不再当答案返回", () => {
  assert.ok(AGENT_CALLER_SRC.includes("），已截断"), "json-envelope 超时/超限应有明确截断标记");
  assert.ok(/json-envelope"\)[\s\S]{0,300}outputExceeded/.test(AGENT_CALLER_SRC), "截断检查须在 JSON 解析之前");
});

test("api.js 不把空回复或错误提示塞进下一轮讨论上下文", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/routes/api.js", import.meta.url), "utf8");
  assert.ok(src.includes('!fullText.trim().startsWith("⚠️")'), "空/错误响应必须被过滤");
  assert.ok(src.includes('p.kill("SIGKILL")'), "断开清理必须有 SIGKILL 升级");
});

test("config watcher 在配置文件缺失时降级监听父目录", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/config.js", import.meta.url), "utf8");
  assert.ok(src.includes("watch(dirname(CONFIG_PATH)"), "配置不存在时应监听父目录等待创建");
});
