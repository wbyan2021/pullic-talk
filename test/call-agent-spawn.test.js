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

// 带 ANSI 颜色的输出：部分 CLI 只看 TERM/COLORTERM 就决定上色
const colorCli = join(tmp, "colorcli");
writeFileSync(colorCli, '#!/bin/sh\nprintf \'\\033[32m绿色答复\\033[0m\\n\'\n');
chmodSync(colorCli, 0o755);

// stderr 里混着启动噪声和真实错误
const noisyCli = join(tmp, "noisycli");
writeFileSync(noisyCli, '#!/bin/sh\nprintf \'%s\\n\' \'Warning: skill conflict detected\' \'Error: 真正的失败原因\' >&2\nexit 1\n');
chmodSync(noisyCli, 0o755);

const envCli = join(tmp, "envcli");
writeFileSync(envCli, '#!/bin/sh\nprintf \'TERM=%s COLORTERM=%s\\n\' "$TERM" "$COLORTERM"\n');
chmodSync(envCli, 0o755);

writeFileSync(join(tmp, "agents.json"), JSON.stringify({
  poscli: { name: "Pos Cli", cli: { command: echoArgs, args: ["{prompt}"], parseMode: "text" } },
  flagcli: { name: "Flag Cli", cli: { command: echoArgs, args: ["-p", "{prompt}"], parseMode: "text" } },
  ndcli: { name: "Nd Cli", cli: { command: ndjsonCli, args: ["{prompt}"], parseMode: "ndjson", textType: "text", textField: "text" } },
  envelopecli: { name: "Envelope Cli", cli: { command: "/no/such/cli-xyz-enoent", args: ["{prompt}"], parseMode: "json-envelope" } },
  colorcli: { name: "Color Cli", cli: { command: colorCli, args: ["{prompt}"], parseMode: "text" } },
  noisycli: { name: "Noisy Cli", cli: { command: noisyCli, args: ["{prompt}"], parseMode: "text" } },
  quietcli: { name: "Quiet Cli", cli: { command: noisyCli, args: ["{prompt}"], parseMode: "text", stderrIgnore: ["Error:"] } },
  envcli: { name: "Env Cli", cli: { command: envCli, args: ["{prompt}"], parseMode: "text" } },
}));

process.env.AGENTS_CONFIG_PATH = join(tmp, "agents.json");

const { callAgent, sanitizeChatRequest } = await import("../src/agent-caller.js");

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

// ===== 2026-09-30 排查项的回归 =====

test("CLI 输出剥掉 ANSI 转义：流式分片和结算文本都不含 ESC", async () => {
  const chunks = [];
  const text = await callAgent("colorcli", "hi", (c) => chunks.push(c));
  assert.ok(text.includes("绿色答复"), `正文必须保留: ${JSON.stringify(text)}`);
  assert.equal(text.includes("\x1b"), false, "结算文本不得含 ESC");
  assert.equal(chunks.join("").includes("\x1b"), false, "流式分片不得含 ESC");
});

test("stderr 的启动噪声被过滤，真实错误仍然呈现", async () => {
  const chunks = [];
  await callAgent("noisycli", "hi", (c) => chunks.push(c));
  const out = chunks.join("");
  assert.ok(out.includes("真正的失败原因"), `真实错误必须保留: ${out}`);
  assert.ok(!out.includes("Warning: skill conflict"), `噪声应被过滤: ${out}`);
});

test("cli.stderrIgnore 覆盖默认噪声表（字符串按行首前缀匹配）", async () => {
  const chunks = [];
  await callAgent("quietcli", "hi", (c) => chunks.push(c));
  const out = chunks.join("");
  assert.ok(out.includes("Warning: skill conflict"), "覆盖后 Warning 不再是噪声");
  assert.ok(!out.includes("真正的失败原因"), "被声明为噪声的 Error 行应被过滤");
});

test("子进程显式拿到 TERM，ANSI 已由调用器剥离所以着色不再有害", async () => {
  const text = await callAgent("envcli", "hi", () => {});
  assert.ok(text.includes("TERM=xterm-256color"), text);
});

test("点名的 targets 全部无效时报错，绝不静默广播给所有成员", () => {
  const bad = sanitizeChatRequest({ message: "hi", targets: ["member-disabled-yesterday"] });
  assert.ok(bad.error, `应返回错误而不是全员广播: ${JSON.stringify(bad)}`);
  assert.equal(bad.data, undefined);

  const partial = sanitizeChatRequest({ message: "hi", targets: ["poscli", "ghost"] });
  assert.deepEqual(partial.data.targets, ["poscli"], "有效目标保留，无效项丢弃");

  const unnamed = sanitizeChatRequest({ message: "hi" });
  assert.ok(unnamed.data.targets.length > 0, "没点名时仍按产品语义发给所有可用成员");
});
