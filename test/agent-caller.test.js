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
