import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const SCRIPT_PATH = new URL("../public/js/escort.js", import.meta.url);
const ELEMENT_IDS = [
  "escort-panel", "escort-toggle", "escort-close", "escort-scrim", "escort-top-label",
  "escort-status-label", "escort-status-message", "escort-status-action", "escort-inline-error",
  "escort-key-setup", "escort-key-saved", "escort-key-form", "escort-key-input",
  "escort-save-key", "escort-masked-key", "escort-retry", "escort-replace", "escort-delete",
  "escort-chat", "escort-messages", "escort-chat-form", "escort-message-input", "escort-send",
];

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
  };
}

function createElement() {
  const listeners = new Map();
  return {
    listeners,
    dataset: {},
    classList: createClassList(),
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener(type, handler) { listeners.set(type, handler); },
    setAttribute() {},
    focus() {},
    replaceChildren() {},
    appendChild() {},
  };
}

function response(ok, body) {
  return { ok, async json() { return body; } };
}

async function flushAsyncHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadEscortUi(api) {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, createElement()]));
  const body = createElement();
  const document = {
    body,
    getElementById(id) { return elements[id] || null; },
    createElement,
  };
  const window = {
    OPS: { api },
    matchMedia() { return { matches: false }; },
    addEventListener() {},
    confirm() { return true; },
  };

  runInNewContext(source, { window, document });
  await flushAsyncHandlers();
  return { elements };
}

const UNCONFIGURED = {
  provider: "deepseek",
  configured: false,
  display: null,
  availability: "unconfigured",
  lastCheckedAt: null,
  error: null,
};

test("credential input stays populated when Keychain save fails", async () => {
  const { elements } = await loadEscortUi(async (url, options = {}) => {
    if (url.endsWith("/status")) return response(true, { ok: true, status: UNCONFIGURED });
    assert.equal(options.method, "PUT");
    return response(false, {
      code: "credential_store_unavailable",
      message: "系统钥匙串暂时不可用。",
      action: "重试",
    });
  });

  elements["escort-key-input"].value = "fake-deepseek-key-123456";
  elements["escort-key-form"].listeners.get("submit")({ preventDefault() {} });
  await flushAsyncHandlers();

  assert.equal(elements["escort-key-input"].value, "fake-deepseek-key-123456");
});

test("credential input clears only after Keychain save succeeds", async () => {
  const { elements } = await loadEscortUi(async (url, options = {}) => {
    if (url.endsWith("/status")) return response(true, { ok: true, status: UNCONFIGURED });
    if (options.method === "PUT") {
      return response(true, {
        ok: true,
        status: { ...UNCONFIGURED, configured: true, availability: "unchecked" },
      });
    }
    assert.equal(options.method, "POST");
    return response(true, {
      ok: true,
      status: { ...UNCONFIGURED, configured: true, availability: "available" },
    });
  });

  elements["escort-key-input"].value = "fake-deepseek-key-123456";
  elements["escort-key-form"].listeners.get("submit")({ preventDefault() {} });
  await flushAsyncHandlers();

  assert.equal(elements["escort-key-input"].value, "");
});
