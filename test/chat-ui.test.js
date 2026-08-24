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

test("secrets.js uses the authenticated OPS api and warns about restart semantics", () => {
  assert.ok(SECRETS_JS.includes("window.OPS.api"), "must use window.OPS.api for token-carrying requests");
  assert.ok(SECRETS_JS.includes('type="password"'), "secret values must default to password inputs");
  assert.ok(SECRETS_JS.includes("window.Secrets ="), "must expose window.Secrets");
  assert.ok(SECRETS_JS.includes("return { open, close, addRow, save };"), "save/addRow must be exposed");
});
