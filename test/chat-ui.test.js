import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const CHAT_HTML = read("public/chat.html");
const CHAT_JS = read("public/js/chat.js");
const CHAT_CSS = read("public/css/chat.css");
const API_JS = read("src/routes/api.js");
const SECRETS_JS = read("public/js/secrets.js");

// ── 装配：重新生成按钮 ──

test("chat.html mounts the regenerate button next to send and stop", () => {
  assert.ok(CHAT_HTML.includes('id="regen"'), "regen button missing");
  assert.ok(CHAT_HTML.includes("regenerateLast()"), "regen button must call regenerateLast");
  const sendPos = CHAT_HTML.indexOf('id="send"');
  const stopPos = CHAT_HTML.indexOf('id="stop"');
  const regenPos = CHAT_HTML.indexOf('id="regen"');
  assert.ok(sendPos > -1 && stopPos > -1 && regenPos > -1);
  assert.ok(sendPos < stopPos && stopPos < regenPos, "button order: send, stop, regen");
});

test("chat.css styles the regenerate button with a visible state", () => {
  assert.ok(CHAT_CSS.includes("#regen {"), "regen styles missing");
  assert.ok(CHAT_CSS.includes("#regen.visible"), "regen visible state missing");
});

// ── 发送链路：历史快照与去重 ──

test("chat.js snapshots history before mounting the user bubble", () => {
  const snapPos = CHAT_JS.indexOf("const historySnapshot = history.slice(-12)");
  const bubblePos = CHAT_JS.indexOf('addMessage("user", escapeHtml(text))');
  assert.ok(snapPos > -1, "historySnapshot missing");
  assert.ok(bubblePos > -1, "user bubble mount missing");
  assert.ok(snapPos < bubblePos, "snapshot must be taken before the user message enters history");
  assert.ok(
    CHAT_JS.includes("history: historySnapshot"),
    "request must send the snapshot (without the current message)",
  );
});

test("chat.js keeps the raw input (with @mentions) for regeneration", () => {
  assert.ok(CHAT_JS.includes("lastEntry.raw = raw"), "raw input must be stored on user history entries");
  assert.ok(CHAT_JS.includes("history[idx].raw || history[idx].text"), "regenerate must prefer raw input");
});

// ── 重新生成行为 ──

test("chat.js truncates history back to the regenerated turn and re-renders", () => {
  assert.ok(CHAT_JS.includes("function regenerateLast"), "regenerateLast missing");
  assert.ok(CHAT_JS.includes("history.length = idx"), "regenerate must truncate history");
  assert.ok(CHAT_JS.includes("renderHistoryMessages()"), "regenerate must re-render messages");
  // 重新生成前先校验接收者，避免截断后无处可发
  const regenStart = CHAT_JS.indexOf("function regenerateLast");
  const validatePos = CHAT_JS.indexOf("parseMentions(raw)", regenStart);
  const truncatePos = CHAT_JS.indexOf("history.length = idx", regenStart);
  assert.ok(validatePos > -1 && truncatePos > -1 && validatePos < truncatePos);
});

test("chat.js hides the regenerate button while streaming and shows it afterwards", () => {
  assert.ok(CHAT_JS.includes("function updateRegenButton"), "updateRegenButton missing");
  assert.ok(
    CHAT_JS.includes('btn.classList.toggle("visible", !isStreaming && hasUser)'),
    "visibility must depend on streaming state and user history",
  );
});

// ── 模型标签 ──

test("chat.js renders the model tag delivered by the thinking event", () => {
  assert.ok(
    CHAT_JS.includes("getOrCreateStreamBody(data.agent, data.model)"),
    "thinking event must pass the model down to the message header",
  );
  assert.ok(
    CHAT_JS.includes("addMessage(agent, \"\", model, false)"),
    "stream body must be created with the model tag",
  );
});

test("api.js resolves and reports the model actually used by each agent", () => {
  assert.ok(
    API_JS.includes('flush("thinking", { agent: target, model: resolveModel(target) })'),
    "thinking SSE event must carry the resolved model",
  );
  assert.ok(
    API_JS.includes("models[target] || AGENTS[target]?.model"),
    "model resolution order must be user choice, then agent default",
  );
});

// ── 服务端防御性去重（与前端快照互为兜底） ──

test("agent-caller dedups a trailing history entry equal to the current message", () => {
  const src = read("src/agent-caller.js");
  assert.ok(
    src.includes('lastMsg.sender === "你" && lastMsg.text === message'),
    "server must skip the trailing duplicate of the current message",
  );
});

// ── 本地 API Key 管理面板装配 ──

test("chat.html mounts the secrets manager and loads its assets", () => {
  assert.ok(CHAT_HTML.includes('id="secrets-btn"'), "secrets button missing");
  assert.ok(CHAT_HTML.includes('id="secrets-overlay"'), "secrets overlay missing");
  assert.ok(CHAT_HTML.includes('href="/css/secrets.css"'), "secrets.css link missing");
  assert.ok(CHAT_HTML.includes('src="/js/secrets.js"'), "secrets.js script missing");
});

test("secrets.js uses the authenticated OPS api and masks existing values", () => {
  assert.ok(SECRETS_JS.includes("window.OPS.api"), "must use window.OPS.api for token-carrying requests");
  assert.ok(SECRETS_JS.includes('type="password"'), "secret values must default to password inputs");
  assert.ok(SECRETS_JS.includes("window.Secrets ="), "must expose window.Secrets");
  assert.ok(SECRETS_JS.includes("return { open, close, addRow, save };"), "save/addRow must be exposed");
});

test("secrets.js never echoes stored values and offers no plaintext reveal", () => {
  assert.ok(!SECRETS_JS.includes("reveal"), "reveal button/logic must be removed (D1)");
  assert.ok(SECRETS_JS.includes("留空 = 保持不变"), "existing entries must use leave-blank-to-keep semantics");
  assert.ok(!/secret-value"\s+value="\$\{/.test(SECRETS_JS), "value inputs must not be rendered from stored values");
});

test("chat.html states the S06 key boundary and restart semantics", () => {
  assert.ok(CHAT_HTML.includes("macOS 钥匙串"), "panel must state escort keys stay in the macOS Keychain (D3)");
  assert.ok(CHAT_HTML.includes("重启服务后会自动加载"), "panel must state the startup auto-load behavior (D2)");
});

test("markdown rendering fails closed when DOMPurify is missing", () => {
  assert.ok(
    /if \(window\.DOMPurify\) return DOMPurify\.sanitize\(html\);\s*return escapeHtml\(text \|\| ""\);/.test(CHAT_JS),
    "renderMarkdown must fall back to escaped text, never raw marked HTML",
  );
  assert.ok(!CHAT_JS.includes("降级为直接渲染"), "fail-open comment must be gone");
});

test("session storage and stream finalization tolerate corruption and aborts", () => {
  assert.ok(CHAT_JS.includes("bodyEl.isConnected"), "detached stream buffers must not write into a switched session");
  assert.ok(CHAT_JS.includes("tri-sessions") && CHAT_JS.includes("catch { return []; }"), "corrupted localStorage must not kill the page");
});

// ── 2026-09-24 对话页多轮审查修复的静态合约 ──

test("config 来源字段（name/role/avatar/model）全部经 escapeHtml 后才进 innerHTML", () => {
  const mustEscape = [
    "${escapeHtml(info.avatar)}",
    "${escapeHtml(info.name)}",
    "${escapeHtml(info.role)}",
    "escapeHtml(shortModel(model))",
    "${escapeHtml(key)}",
    "${escapeHtml(a.name || key)}",
  ];
  for (const frag of mustEscape) {
    assert.ok(CHAT_JS.includes(frag), `missing escaped interpolation: ${frag}`);
  }
  // innerHTML 上下文中的裸插值不得再出现（title 属性 / textContent 赋值不属于注入面）
  assert.ok(!CHAT_JS.includes("${info.avatar}</div>"));
  assert.ok(!CHAT_JS.includes('${info.name}</span>'));  assert.ok(!CHAT_JS.includes('<span class="msg-role">${info.role}</span>'));
  assert.ok(!CHAT_JS.includes('<span class="msg-model">${model}</span>'));
});

test("Enter 发送尊重中文输入法组词状态（isComposing / keyCode 229）", () => {
  assert.ok(CHAT_JS.includes("e.isComposing || e.keyCode === 229"), "IME 组词期不得触发发送/弹窗操作");
});

test("mention 解析有左边界且不再折叠换行/缩进", () => {
  assert.ok(CHAT_JS.includes("(?<![a-z0-9_@])"), "需要左边界防止 a@pi.example 被误解析");
  assert.ok(!CHAT_JS.includes('replace(/\\s{2,}/g, " ")'), "不得无条件折叠空白（多段消息会被压扁）");
});

test("多轮分隔条持久化：轮次写入 history 并在回放/导出时重建", () => {
  assert.ok(CHAT_JS.includes("entry.round = currentRound"), "agent 消息须记录轮次");
  assert.ok(CHAT_JS.includes("addRoundDivider(msg.round"), "回放时按轮次重建分隔条");
  assert.ok(CHAT_JS.includes("msg.round"), "导出与回放须读取轮次字段");
});

test("停止/断开路径的清理：状态点熄灭、空回复不入历史、删除会话先停止", () => {
  assert.ok(/setStatus\(agent, false\); \/\/ abort/.test(CHAT_JS), "finally 里必须熄灭状态点");
  assert.ok(CHAT_JS.includes("if (!buf.text && !fullText && stoppedByUser)"), "停止且无文本时移除气泡不入历史");
  assert.ok(/deleteSession[\s\S]{0,200}if \(isStreaming\) stopGeneration\(\)/.test(CHAT_JS), "流式中删除当前会话须先停止");
});

test("关页兜底与存储溢出提示", () => {
  assert.ok(CHAT_JS.includes('window.addEventListener("pagehide"'), "关页前须把未完成回复落盘");
  assert.ok(CHAT_JS.includes("本地存储已满"), "存储两次失败须提示用户");
});

test("流式渲染节流：限制全量重渲染频率", () => {
  assert.ok(CHAT_JS.includes("STREAM_FLUSH_MS"), "须有时间节流常量");
});

test("Escape 关闭 mention 弹窗后点击输入框不再强行重开", () => {
  assert.ok(CHAT_JS.includes("mentionSuppressed"), "需要主动关闭抑制标记");
});
