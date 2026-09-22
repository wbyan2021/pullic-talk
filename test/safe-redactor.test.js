import test from "node:test";
import assert from "node:assert/strict";

import {
  FACT_LEVELS,
  REDACTION_MARKER,
  redactText,
} from "../src/services/safe-redactor.js";

test("exports the stable fact levels", () => {
  assert.deepEqual(FACT_LEVELS, {
    VERIFIED: "verified",
    USER_CONFIRMED: "user_confirmed",
    AGENT_REPORTED: "agent_reported",
    RECORDED_NOT_REVERIFIED: "recorded_not_reverified",
    UNKNOWN: "unknown",
  });
});

test("redacts labeled API keys, tokens, passwords and private keys", () => {
  const result = redactText([
    "API_KEY=sk-test-12345678901234567890",
    "token: bearer-value-1234567890",
    "password='do-not-save-this'",
    "-----BEGIN PRIVATE KEY-----secret-material-----END PRIVATE KEY-----",
  ].join("\n"));

  assert.equal(result.withheld, true);
  assert.equal(result.truncated, false);
  assert.ok(result.text.includes(REDACTION_MARKER));
  assert.ok(!result.text.includes("sk-test-12345678901234567890"));
  assert.ok(!result.text.includes("do-not-save-this"));
  assert.ok(!result.text.includes("secret-material"));
});

test("redacts known bearer and command-line secret forms", () => {
  const result = redactText("Authorization: Bearer abcdefghijklmnop --api-key sk-live-1234567890123456");
  assert.equal(result.withheld, true);
  assert.ok(!result.text.includes("abcdefghijklmnop"));
  assert.ok(!result.text.includes("sk-live-1234567890123456"));
});

test("preserves ordinary text and paths", () => {
  const result = redactText("在 /tmp/s04-acceptance 运行 npm test，结果为 163/163。");
  assert.deepEqual(result, {
    text: "在 /tmp/s04-acceptance 运行 npm test，结果为 163/163。",
    withheld: false,
    truncated: false,
  });
});

test("truncates by UTF-8 byte limit without logging or throwing", () => {
  const result = redactText("中文内容abcdefgh", { maxBytes: 10 });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= 10);
});

test("non-string values produce a safe empty result", () => {
  assert.deepEqual(redactText(null), { text: "", withheld: false, truncated: false });
  assert.deepEqual(redactText({ secret: "x" }), { text: "", withheld: false, truncated: false });
});

test("covers underscore compounds, JSON quotes, flag variants, and separators", () => {
  const cases = [
    "access_token: supersecret99",
    '"api_key": "sk-abc123def456"',
    "refresh_token=xyz999",
    "--secret mysecretvalue",
    "client_secret: hunter2",
    "secret_key: value123",
  ];
  for (const text of cases) {
    const r = redactText(text);
    assert.equal(r.withheld, true, `should withhold: ${text}`);
    assert.ok(!r.text.includes("supersecret99"), "underscore compound value must be masked");
    assert.ok(!r.text.includes("hunter2"), "client_secret value must be masked");
  }
  // 普通词不受影响
  assert.equal(redactText("the tokenizer: works fine").withheld, false);
  assert.equal(redactText("total: 42 items").withheld, false);
});
