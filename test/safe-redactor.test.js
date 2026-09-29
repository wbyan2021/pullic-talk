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

// 供应商 token 的固有前缀 + URL 内嵌凭据：这些值不带键名地裸出现在
// git remote 输出、CLI 报错和依赖树里，只靠键名规则匹配不到（2026-09-30 排查发现 7 类穿透）。
//
// 带前缀的夹具值必须在代码里拼装出来，不能把真实形态的字面量写进文件：
// 本测试第一版就因为直接写了 Stripe 文档示例 key 而被 GitHub 的 push protection
// 拦下——扫描器无法区分示例值和真的 sk_live_ 生产密钥，而进了 Git 历史的东西擦不干净。
// 拼装后的运行时值仍然完整命中同一条正则，校验强度不变。
const frag = (...parts) => parts.join("");
const NOT_A_REAL_KEY = frag("NOTAREAL", "KEY0123456789");

const PROVIDER_SECRET_FIXTURES = [
  ["github_pat_11ABCDEFG0123456789abcdefghij", "GitHub fine-grained PAT"],
  ["ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "GitHub classic PAT"],
  ["gho_1234567890abcdefghij1234567890", "GitHub OAuth token"],
  ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
  ["ASIAIOSFODNN7EXAMPLE", "AWS temporary access key id"],
  ["xoxb-123456789012-abcdefghij", "Slack bot token"],
  ["AIzaSyD-aaaaaaaaaaaaaaaaaaaaaaaaaa", "Google API key"],
  ["glpat-XXXXXXXXXXXXXXXXXXXX", "GitLab PAT"],
  ["npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm access token"],
  ["hf_AbCdEfGhIj1234567890", "Hugging Face token"],
  [frag("sk", "_live_", NOT_A_REAL_KEY), "Stripe live secret key"],
  [frag("rk", "_test_", NOT_A_REAL_KEY), "Stripe restricted test key"],
  ["dop_v1_0123456789abcdef0123456789abcdef0123456789abcdef", "DigitalOcean token"],
];

test("redacts provider tokens that appear without any label", () => {
  for (const [secret, label] of PROVIDER_SECRET_FIXTURES) {
    const r = redactText(`something ${secret} trailing words`);
    assert.equal(r.withheld, true, `${label}: must be withheld`);
    assert.ok(!r.text.includes(secret), `${label}: value must not survive`);
  }
});

test("redacts credentials embedded in URL userinfo but keeps the URL usable", () => {
  const r = redactText("remote  https://user:p4ssw0rd@github.com/org/repo.git");
  assert.equal(r.withheld, true);
  assert.ok(!r.text.includes("p4ssw0rd"), "url password must be masked");
  assert.ok(r.text.includes("https://user:"), "scheme and user stay for diagnosis");
  assert.ok(r.text.includes("@github.com/org/repo.git"), "host and path stay for diagnosis");

  const gitlabToken = frag("glpat", "-", NOT_A_REAL_KEY);
  const tokenInUrl = redactText(`https://oauth2:${gitlabToken}@gitlab.com/x/y.git`);
  assert.ok(!tokenInUrl.text.includes(gitlabToken), "url 里的 gitlab token 必须被遮蔽");

  // 无凭据的普通 URL 不得被改写
  const clean = redactText("https://github.com/wbyan2021/pullic-talk.git");
  assert.equal(clean.withheld, false);
  assert.equal(clean.text, "https://github.com/wbyan2021/pullic-talk.git");
});

test("redacts access-key style field names that the old table missed", () => {
  for (const text of [
    "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ]) {
    const r = redactText(text);
    assert.equal(r.withheld, true, `should withhold: ${text}`);
    assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"), `key id must be masked: ${text}`);
    assert.ok(!r.text.includes("wJalrXUtnFEMI"), `secret must be masked: ${text}`);
  }
});

// 加宽规则必须保持保守： ordinary 构建输出、字段名和文档路径都不该被整体遮蔽，
// 否则黑匣子/交接记录会失去可读性（fail-safe 变成 fail-unusable）。
test("does not over-redact ordinary developer output", () => {
  const benign = [
    "npm test",
    "3 packages are looking for funding",
    "docs/ai-ops/NOW.md",
    "branch: codex/v0.1-s06-web-key-management",
    "passwordless login configured",
    "const tokenCount = 3; // token is part of an identifier",
    "The keyword: value pair is fine",
    "PASS  src/services/__tests__/login.test.ts (1.289 s)",
  ];
  for (const text of benign) {
    const r = redactText(text);
    assert.equal(r.withheld, false, `must not withhold: ${text}`);
    assert.equal(r.text, text, `must be byte-identical: ${text}`);
  }
});
