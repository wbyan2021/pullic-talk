import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 独立文件：AGENTS_CONFIG_PATH 必须在 import agent-caller（会加载 config.js）之前生效
const tmp = mkdtempSync(join(tmpdir(), "call-agent-spawn-"));

// 把参数逐行打印的假 CLI（parseMode text）
const echoArgs = join(tmp, "echoargs");
writeFileSync(echoArgs, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
chmodSync(echoArgs, 0o755);

// ndjson 输出的假 CLI：一条结构化 text（对象）、一条普通 text
const ndjsonCli = join(tmp, "ndjsoncli");
writeFileSync(ndjsonCli, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"text","text":{"a":1}}\' \'{"type":"text","text":"hello"}\'\n');
chmodSync(ndjsonCli, 0o755);

writeFileSync(join(tmp, "agents.json"), JSON.stringify({
  poscli: { name: "Pos Cli", cli: { command: echoArgs, args: ["{prompt}"], parseMode: "text" } },
  flagcli: { name: "Flag Cli", cli: { command: echoArgs, args: ["-p", "{prompt}"], parseMode: "text" } },
  ndcli: { name: "Nd Cli", cli: { command: ndjsonCli, args: ["{prompt}"], parseMode: "ndjson", textType: "text", textField: "text" } },
  envelopecli: { name: "Envelope Cli", cli: { command: "/no/such/cli-xyz-enoent", args: ["{prompt}"], parseMode: "json-envelope" } },
}));

process.env.AGENTS_CONFIG_PATH = join(tmp, "agents.json");

const { callAgent } = await import("../src/agent-caller.js");

after(() => rmSync(tmp, { recursive: true, force: true }));

test("位置参数形式的 prompt 以 - 开头时插入 -- 终止符，防止被当选项解析", async () => {
  const text = await callAgent("poscli", "-h 你好", () => {});
  const lines = text.split("\n").filter(Boolean);
  assert.deepEqual(lines, ["--", "-h 你好"]);
});

test("选项值形式的 prompt（-p {prompt}）不插入 --", async () => {
  const text = await callAgent("flagcli", "-h 你好", () => {});
  const lines = text.split("\n").filter(Boolean);
  assert.deepEqual(lines, ["-p", "-h 你好"]);
});

test("ndjson 对象型 text 字段序列化为 JSON，而不是 [object Object]", async () => {
  const text = await callAgent("ndcli", "q", () => {});
  assert.ok(text.includes('{"a":1}'));
  assert.ok(text.includes("hello"));
  assert.ok(!text.includes("[object Object]"));
});

test("spawn ENOENT 的 error+close 双事件只结算一次，json-envelope 下仅一条提示", async () => {
  const chunks = [];
  const text = await callAgent("envelopecli", "q", (c) => chunks.push(c));
  assert.equal(text, "");
  assert.equal(chunks.length, 1, "ENOENT 只应输出一条「不可用」提示");
  assert.ok(chunks[0].includes("不可用"));
});
