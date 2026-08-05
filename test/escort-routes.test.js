import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import escortRoutes from "../src/routes/escort.js";
import { EscortServiceError } from "../src/services/escort-service.js";

const FAKE_KEY = "fake-deepseek-key-123456";
const SAFE_STATUS = {
  provider: "deepseek",
  configured: true,
  display: "••••••••（已安全保存）",
  availability: "available",
  lastCheckedAt: "2026-08-06T12:00:00.000Z",
  error: null,
};

class FakeApp {
  constructor() { this.routes = new Map(); }
  register(method, path, handler) { this.routes.set(`${method} ${path}`, handler); }
  get(path, handler) { this.register("GET", path, handler); }
  put(path, handler) { this.register("PUT", path, handler); }
  delete(path, handler) { this.register("DELETE", path, handler); }
  post(path, handler) { this.register("POST", path, handler); }
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.body = undefined;
    this.writableEnded = false;
  }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.body = body; this.writableEnded = true; return this; }
}

function createService(overrides = {}) {
  const calls = { status: 0, save: [], delete: 0, check: 0, send: [] };
  const service = {
    calls,
    async getStatus() { calls.status += 1; return SAFE_STATUS; },
    async saveCredential(apiKey) { calls.save.push(apiKey); return { ...SAFE_STATUS, availability: "unchecked" }; },
    async deleteCredential() { calls.delete += 1; return { ...SAFE_STATUS, configured: false, display: null, availability: "unconfigured" }; },
    async checkConnection() { calls.check += 1; return SAFE_STATUS; },
    async sendMessage(input) {
      calls.send.push(input);
      return { text: "reply", model: "deepseek-v4-flash", provider: "deepseek", status: SAFE_STATUS };
    },
    ...overrides,
  };
  return service;
}

function setup(service = createService(), now = () => 1_000) {
  const app = new FakeApp();
  escortRoutes(app, { escortService: service, now });
  return { app, service };
}

async function invoke(app, method, path, body) {
  const handler = app.routes.get(`${method} ${path}`);
  assert.equal(typeof handler, "function", `missing ${method} ${path}`);
  const req = { body };
  const res = new FakeResponse();
  await handler(req, res);
  return res;
}

test("registers the exact S01 Provider and Escort routes", () => {
  const { app } = setup();
  assert.deepEqual([...app.routes.keys()], [
    "GET /api/providers/deepseek/status",
    "PUT /api/providers/deepseek/credential",
    "DELETE /api/providers/deepseek/credential",
    "POST /api/providers/deepseek/check",
    "POST /api/escort/messages",
  ]);
});

test("status, save, and delete return safe shapes without echoing the Key", async () => {
  const { app, service } = setup();
  const status = await invoke(app, "GET", "/api/providers/deepseek/status");
  assert.deepEqual(status.body, { ok: true, status: SAFE_STATUS });

  const saved = await invoke(app, "PUT", "/api/providers/deepseek/credential", { apiKey: FAKE_KEY });
  assert.equal(saved.statusCode, 200);
  assert.equal(service.calls.save[0], FAKE_KEY);
  assert.equal(JSON.stringify(saved.body).includes(FAKE_KEY), false);

  const deleted = await invoke(app, "DELETE", "/api/providers/deepseek/credential");
  assert.equal(deleted.body.status.availability, "unconfigured");
  assert.equal(service.calls.delete, 1);
});

test("route responses whitelist status fields even if an internal service adds a secret", async () => {
  const unsafeStatus = { ...SAFE_STATUS, apiKey: FAKE_KEY, internal: { secret: FAKE_KEY } };
  const { app } = setup(createService({ async getStatus() { return unsafeStatus; } }));

  const res = await invoke(app, "GET", "/api/providers/deepseek/status");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, status: SAFE_STATUS });
  assert.equal(JSON.stringify(res.body).includes(FAKE_KEY), false);
});

test("PUT rejects a missing apiKey before calling the service", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "PUT", "/api/providers/deepseek/credential", {});
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "invalid_credential_input");
  assert.equal(service.calls.save.length, 0);
});

test("connection check always returns a structured Provider status", async () => {
  const failed = {
    ...SAFE_STATUS,
    availability: "unavailable",
    error: { code: "credential_invalid", message: "Key 无效", action: "替换 Key", retryable: false },
  };
  const { app } = setup(createService({ async checkConnection() { return failed; } }));
  const res = await invoke(app, "POST", "/api/providers/deepseek/check");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: false, status: failed });
});

test("message success returns reply metadata and safe status", async () => {
  const { app, service } = setup();
  const res = await invoke(app, "POST", "/api/escort/messages", { message: "hello", history: [] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply.text, "reply");
  assert.equal(res.body.reply.model, "deepseek-v4-flash");
  assert.deepEqual(service.calls.send[0].history, []);
});

for (const [code, expectedStatus] of [
  ["invalid_message", 400],
  ["busy", 409],
  ["credential_missing", 409],
  ["credential_invalid", 424],
  ["insufficient_balance", 424],
  ["rate_limited", 424],
  ["credential_store_unavailable", 424],
  ["network_error", 502],
  ["provider_unavailable", 502],
  ["provider_request_invalid", 502],
  ["invalid_response", 502],
  ["timeout", 504],
]) {
  test(`maps ${code} to safe local HTTP ${expectedStatus}`, async () => {
    const service = createService({
      async sendMessage() {
        throw new EscortServiceError(code, "safe message", {
          retryable: expectedStatus >= 500,
          httpStatus: expectedStatus,
          action: "safe action",
        });
      },
    });
    const { app } = setup(service);
    const res = await invoke(app, "POST", "/api/escort/messages", { message: "hello", history: [] });
    assert.equal(res.statusCode, expectedStatus);
    assert.notEqual(res.statusCode, 401);
    assert.deepEqual(res.body, {
      ok: false,
      code,
      message: "safe message",
      action: "safe action",
      retryable: expectedStatus >= 500,
    });
  });
}

test("check and chat share a 12-per-minute local cost limiter", async () => {
  let now = 10_000;
  const { app, service } = setup(createService(), () => now);
  for (let index = 0; index < 6; index += 1) {
    assert.equal((await invoke(app, "POST", "/api/providers/deepseek/check")).statusCode, 200);
    assert.equal((await invoke(app, "POST", "/api/escort/messages", { message: "hi" })).statusCode, 200);
  }
  const limited = await invoke(app, "POST", "/api/escort/messages", { message: "one too many" });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, "local_rate_limited");
  assert.equal(service.calls.send.length, 6);

  now += 60_001;
  assert.equal((await invoke(app, "POST", "/api/escort/messages", { message: "after window" })).statusCode, 200);
});

test("unknown errors never leak stack or raw messages", async () => {
  const { app } = setup(createService({
    async getStatus() { throw new Error(`raw internal ${FAKE_KEY}`); },
  }));
  const res = await invoke(app, "GET", "/api/providers/deepseek/status");
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    ok: false,
    code: "internal_error",
    message: "护航服务暂时不可用，请重新加载后重试。",
    action: "重新加载页面",
    retryable: true,
  });
  assert.equal(JSON.stringify(res.body).includes(FAKE_KEY), false);
});
