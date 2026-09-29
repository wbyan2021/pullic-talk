"use strict";

export const FACT_LEVELS = Object.freeze({
  VERIFIED: "verified",
  USER_CONFIRMED: "user_confirmed",
  AGENT_REPORTED: "agent_reported",
  RECORDED_NOT_REVERIFIED: "recorded_not_reverified",
  UNKNOWN: "unknown",
});

export const REDACTION_MARKER = "[withheld_sensitive]";

const DEFAULT_MAX_BYTES = 4 * 1024;

// 凭据“键名”表：ai-handoff 的按字段整体遮蔽复用同一份定义，避免两处规则各自漂移。
// 长式必须在短式之前（SECRET_ACCESS_KEY_ID 要先于 secret 尝试），否则只能匹配到前缀。
export const SENSITIVE_KEY_ALTERNATIVES = [
  "secret[-_]?access[-_]?key(?:[-_]?id)?",
  "access[-_]?key(?:[-_]?id)?",
  "api[-_]?key",
  "api[-_]?secret",
  "auth[-_]?token",
  "access[-_]?token",
  "refresh[-_]?token",
  "session[-_]?token",
  "bearer[-_]?token",
  "id[-_]?token",
  "client[-_]?secret",
  "secret[-_]?key",
  "private[-_]?key",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "credential",
].join("|");

// 字段名判定用（ai-handoff 对整个字段做遮蔽）：只要名字里含凭据词就遮蔽，
// 因此不带值上下文的后行断言，保持原有“包含即算”的语义。
export const SENSITIVE_KEY_NAME_PATTERN = new RegExp(
  `(?:${SENSITIVE_KEY_ALTERNATIVES})`,
  "i",
);

// 供应商 access token 的固有前缀：这些值通常不带任何标签地裸出现在日志、
// git remote 输出和 CLI 报错里，只靠“键名 + 分隔符”规则永远匹配不到。
const PROVIDER_TOKEN_RE = new RegExp(
  "(?<![A-Za-z0-9_])(?:"
  + [
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "xox[a-z]-[A-Za-z0-9-]{10,}",
    "AKIA[0-9A-Z]{16}",
    "ASIA[0-9A-Z]{16}",
    "AIza[0-9A-Za-z_-]{20,}",
    "glpat-[A-Za-z0-9_-]{15,}",
    "npm_[A-Za-z0-9]{20,}",
    "hf_[A-Za-z0-9]{10,}",
    "[sr]k_(?:live|test)_[A-Za-z0-9]{10,}",
    "dop_v1_[A-Za-z0-9]{20,}",
    "sg_[A-Za-z0-9_.-]{20,}",
  ].join("|")
  + ")",
  "gi",
);

// URL 内嵌 basic-auth 凭据：scheme://user:password@host —— `git remote -v` 的常见输出
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]*):([^\s/@]*)@/gi;

// “键名 + : 或 = + 值”：引号包裹的值优先整体匹配，否则吃到分隔符为止
const KEY_VALUE_RE = new RegExp(
  `(?<![A-Za-z0-9])(["']?(?:${SENSITIVE_KEY_ALTERNATIVES})["']?\\s*[:=]\\s*)`
  + `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;\\]}]+)`,
  "gi",
);

function replaceSensitive(text, pattern, replacement, state) {
  return text.replace(pattern, (...args) => {
    state.withheld = true;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let bounded = bytes.subarray(0, maxBytes).toString("utf8");
  while (bounded && Buffer.byteLength(bounded, "utf8") > maxBytes) {
    bounded = bounded.slice(0, -1);
  }
  return {
    text: bounded,
    truncated: true,
  };
}

/**
 * Redact text before it can enter a blackbox event or project handoff file.
 * This function never logs or persists its input.
 */
export function redactText(value, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof value !== "string") {
    return { text: "", withheld: false, truncated: false };
  }

  const state = { withheld: false };
  let text = value;

  text = replaceSensitive(
    text,
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
    REDACTION_MARKER,
    state,
  );
  text = replaceSensitive(
    text,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    "Bearer " + REDACTION_MARKER,
    state,
  );
  text = replaceSensitive(
    text,
    /(--(?:api[-_]?key|token|password|secret|private[-_]?key|credential)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (_match, prefix) => prefix + REDACTION_MARKER,
    state,
  );
  // 键形态：access_key / access_token / client_secret 等下划线复合词、
  // JSON 形态 "api_key": "…"、YAML 形态 password: …。
  // 不能用 \b 起界（下划线是单词字符，\b 会漏掉 access_token）；用负向后行断言。
  // 键名表由 SENSITIVE_KEY_ALTERNATIVES 单一来源构造，ai-handoff 复用同一份。
  text = replaceSensitive(
    text,
    KEY_VALUE_RE,
    (_match, prefix) => prefix + REDACTION_MARKER,
    state,
  );
  text = replaceSensitive(
    text,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g,
    REDACTION_MARKER,
    state,
  );
  // 无标签的供应商 token：这些值不带键名地裸出现（git remote、CLI 报错、依赖树输出），
  // 只靠键名规则永远匹配不到，须按固有前缀识别
  text = replaceSensitive(text, PROVIDER_TOKEN_RE, REDACTION_MARKER, state);
  // URL 内嵌 basic-auth 凭据：保留 scheme 与用户名，只遮蔽密码段
  text = replaceSensitive(
    text,
    URL_USERINFO_RE,
    (_match, scheme, user) => `${scheme}${user}:${REDACTION_MARKER}@`,
    state,
  );

  const boundedBytes = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : DEFAULT_MAX_BYTES;
  const bounded = truncateUtf8(text, boundedBytes);

  return {
    text: bounded.text,
    withheld: state.withheld,
    truncated: bounded.truncated,
  };
}
