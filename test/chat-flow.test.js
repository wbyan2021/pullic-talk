import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const SCRIPT_PATH = new URL("../public/js/chat.js", import.meta.url);

// ── 最小 DOM / 浏览器桩，够跑通 chat.js 的发送与重新生成链路 ──

function makeClassList() {
  const set = new Set();
  return {
    add: (v) => set.add(v),
    remove: (v) => set.delete(v),
    toggle(v, force) {
      const on = force === undefined ? !set.has(v) : !!force;
      if (on) set.add(v); else set.delete(v);
      return on;
    },
    contains: (v) => set.has(v),
  };
}

function makeElement(tag = "div") {
  const el = {
    tagName: tag,
    dataset: {},
    style: {},
    children: [],
    value: "",
    title: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    selectionStart: 0,
    classList: makeClassList(),
    listeners: new Map(),
    _html: "",
    _text: "",
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    setSelectionRange() {},
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    closest() { return null; },
    querySelector() { return makeElement("div"); },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0 }; },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v); el._text = String(v).replace(/<[^>]*>/g, ""); },
    configurable: true,
  });
  Object.defineProperty(el, "textContent", {
    get() { return el._text; },
    set(v) { el._text = String(v); el._html = String(v); },
    configurable: true,
  });
  return el;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const ELEMENT_IDS = [
  "messages", "input", "send", "stop", "regen", "mention-popup", "mode-select",
  "thinking-mode", "rounds-select", "sidebar", "agent-toggles", "logo-text",
  "status-bar", "history-list", "hljs-theme",
];

const MODELS_AVAILABLE = {
  echoai: {
    name: "Echo AI", model: "echo-1", role: "test role", color: "#ff5500", avatar: "E",
    models: ["echo-1", "echo-2"], source: "user", available: true, path: "/x/echoai", installId: null,
  },
};

function sseBytes(lines) {
  return new TextEncoder().encode(lines.join("\n\n") + "\n\n");
}

async function flush(rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// 加载 chat.js：models 控制 /api/models 返回；chatReplays 依次提供每次 /api/chat 的 SSE 事件；
// initialStorage 可预置 localStorage 键值（如固定发言顺序 tri-agent-order）
async function loadChatUi(models, chatReplays, initialStorage) {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, makeElement()]));
  const storage = makeStorage();
  for (const [k, v] of Object.entries(initialStorage || {})) storage.setItem(k, v);
  const requests = []; // { json, regenVisibleDuringCall }
  let replayIndex = 0;

  const api = async (url, opts = {}) => {
    if (url === "/api/models") {
      return { ok: true, async json() { return models; } };
    }
    if (url === "/api/chat") {
      requests.push({
        url,
        json: opts.json,
        regenVisibleDuringCall: elements["regen"].classList.contains("visible"),
      });
      const events = chatReplays[replayIndex++] || [
        'event: thinking\ndata: {"agent":"echoai","model":"echo-2"}',
        'event: done\ndata: {"agent":"echoai","text":"reply body"}',
        "event: end\ndata: {}",
      ];
      const bytes = sseBytes(events);
      let done = false;
      return {
        ok: true,
        async json() { return {}; },
        body: {
          getReader() {
            return {
              async read() {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: bytes };
              },
            };
          },
        },
      };
    }
    throw new Error("unexpected api call: " + url);
  };

  const documentStub = {
    title: "",
    documentElement: makeElement("html"),
    body: makeElement("body"),
    getElementById(id) {
      if (id === "welcome") return null; // 欢迎屏未渲染（或已被移除）
      return elements[id] || makeElement();
    },
    createElement: (tag) => makeElement(tag),
    addEventListener() {},
  };

  const windowStub = { OPS: { api }, innerWidth: 1280, addEventListener() {} };
  const context = {
    window: windowStub,
    OPS: windowStub.OPS,
    document: documentStub,
    localStorage: storage,
    marked: {
      setOptions() {},
      use() {},
      parse: (t) => String(t || ""),
      Renderer: class {
        code() { return "<pre><code></code></pre>"; }
      },
    },
    console,
    Date,
    AbortController,
    TextDecoder,
    TextEncoder,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: {},
  };
  context.globalThis = context;

  runInNewContext(source, context);
  await flush(); // 等 loadAgents 完成

  return { context, elements, storage, requests };
}

// ── 用例 ──

test("固定发言顺序：targets 按拖拽保存的顺序输出，与 @ 书写顺序无关", async () => {
  const models = {
    alpha: { ...MODELS_AVAILABLE.echoai, name: "Alpha" },
    beta: { ...MODELS_AVAILABLE.echoai, name: "Beta" },
    gamma: { ...MODELS_AVAILABLE.echoai, name: "Gamma" },
  };
  // 用户拖拽后的固定顺序：gamma → alpha → beta
  const { context, elements, requests, storage } = await loadChatUi(models, [], {
    "tri-agent-order": JSON.stringify(["gamma", "alpha", "beta"]),
  });

  // 不带 @ 的普通消息：按固定顺序发给全部选中成员
  elements["input"].value = "讨论一下";
  await context.sendMessage();
  await flush();
  assert.deepEqual([...requests[0].json.targets], ["gamma", "alpha", "beta"]);

  // @ 书写顺序与固定顺序相反时，仍按固定顺序执行（协作模式即发言顺序）
  elements["input"].value = "@beta @alpha 先说说";
  await context.sendMessage();
  await flush();
  assert.deepEqual([...requests[1].json.targets], ["alpha", "beta"]);

  // 顺序被持久化回 localStorage，刷新后不丢
  assert.deepEqual(JSON.parse(storage.getItem("tri-agent-order")), ["gamma", "alpha", "beta"]);
});

test("sending a message excludes the current message from the history payload", async () => {
  const { context, elements, requests, storage } = await loadChatUi(MODELS_AVAILABLE, []);

  elements["input"].value = "@echoai hello world";
  await context.sendMessage();
  await flush();

  assert.equal(requests.length, 1, "exactly one /api/chat request");
  assert.equal(elements["input"].value, "", "input must be cleared immediately after sending");
  const payload = requests[0].json;
  assert.equal(payload.message, "hello world", "@mention is stripped from the message");
  assert.deepEqual([...payload.targets], ["echoai"]);
  assert.equal(payload.history.length, 0, "current message must NOT be inside history");

  // 历史已落盘：用户消息带 raw（含 @mention），agent 回复在后
  const saved = JSON.parse(storage.getItem("tri-sessions") || "[]");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].history.length, 2);
  assert.equal(saved[0].history[0].agent, "user");
  assert.equal(saved[0].history[0].raw, "@echoai hello world");
  assert.equal(saved[0].history[0].text, "hello world");
  assert.equal(saved[0].history[1].agent, "echoai");
  assert.equal(requests[0].regenVisibleDuringCall, false, "regen must be hidden while streaming");
  assert.equal(elements["regen"].classList.contains("visible"), true, "regen visible after stream ends");
});

test("the model from the thinking event is rendered into the message header", async () => {
  const { context, elements } = await loadChatUi(MODELS_AVAILABLE, []);

  elements["input"].value = "show me your model";
  await context.sendMessage();
  await flush();

  // messages.children: [0] 用户消息, [1] agent 消息
  const agentMsg = elements["messages"].children[1];
  assert.ok(agentMsg, "agent message element exists");
  assert.ok(agentMsg._html.includes('class="msg-model"'), "model tag span rendered");
  assert.ok(agentMsg._html.includes("echo-2"), "model name from thinking event shown");
});

test("regenerate re-sends the raw input and truncates the conversation after it", async () => {
  const { context, elements, requests } = await loadChatUi(MODELS_AVAILABLE, []);

  elements["input"].value = "first question";
  await context.sendMessage();
  await flush();

  elements["input"].value = "@echoai second question";
  await context.sendMessage();
  await flush();

  assert.equal(requests.length, 2);
  // 第二次发送的历史里包含第一轮，但不含本轮消息
  assert.equal(requests[1].json.history.length, 2);
  assert.ok(!requests[1].json.history.some((h) => h.text.includes("second question")));

  context.regenerateLast();
  await flush();

  assert.equal(requests.length, 3, "regenerate triggers a new request");
  assert.equal(requests[2].json.message, "second question", "raw text (mention stripped) re-sent");
  assert.deepEqual([...requests[2].json.targets], ["echoai"], "original @target preserved");
  // 截断后重新发送：历史只保留第一轮，不含被重发的这条
  assert.equal(requests[2].json.history.length, 2);
  assert.ok(requests[2].json.history.some((h) => h.text === "first question"));
  assert.ok(!requests[2].json.history.some((h) => h.text.includes("second question")));
});

test("send is rejected without usable targets and the input is preserved", async () => {
  const models = {
    echoai: { ...MODELS_AVAILABLE.echoai, available: false, path: null, installId: "echoai" },
  };
  const { context, elements, requests } = await loadChatUi(models, []);

  elements["input"].value = "anybody there?";
  await context.sendMessage();
  await flush();

  assert.equal(requests.length, 0, "no request should be sent");
  assert.equal(elements["input"].value, "anybody there?", "input must be preserved for editing");
});
