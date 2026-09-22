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
  // 键形态：access_token / refresh_token / client_secret 等下划线复合词、
  // JSON 形态 "api_key": "…"、YAML 形态 password: …。
  // 不能用 \b 起界（下划线是单词字符，\b 会漏掉 access_token）；用负向后行断言。
  text = replaceSensitive(
    text,
    /(?<![A-Za-z0-9])(["']?(?:api[-_]?key|api[-_]?secret|auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret[-_]?key|private[-_]?key|token|secret|password|passwd|authorization|credential)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\]}]+)/gi,
    (_match, prefix) => prefix + REDACTION_MARKER,
    state,
  );
  text = replaceSensitive(
    text,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g,
    REDACTION_MARKER,
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
