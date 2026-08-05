const BASE_URL = "https://api.deepseek.com";
const CHAT_PATH = "/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 2048;
const VALID_ROLES = new Set(["system", "user", "assistant"]);

const ERROR_DEFINITIONS = {
  credential_missing: {
    message: "尚未配置 DeepSeek API Key。",
    retryable: false,
    availability: "unconfigured",
    httpStatus: 409,
  },
  credential_invalid: {
    message: "DeepSeek API Key 无效或已失效，请替换后重试。",
    retryable: false,
    availability: "unavailable",
    httpStatus: 424,
  },
  insufficient_balance: {
    message: "DeepSeek 账户余额不足，请充值后重试。",
    retryable: false,
    availability: "limited",
    httpStatus: 424,
  },
  rate_limited: {
    message: "DeepSeek 当前请求受限，请稍后重试。",
    retryable: true,
    availability: "limited",
    httpStatus: 424,
  },
  provider_request_invalid: {
    message: "驾驶舱与 DeepSeek 的请求协议不兼容，需要更新应用。",
    retryable: false,
    availability: "unavailable",
    httpStatus: 502,
  },
  provider_unavailable: {
    message: "DeepSeek 服务暂时不可用，请稍后重试。",
    retryable: true,
    availability: "unavailable",
    httpStatus: 502,
  },
  network_error: {
    message: "本机暂时无法连接 DeepSeek，请检查网络后重试。",
    retryable: true,
    availability: "unavailable",
    httpStatus: 502,
  },
  timeout: {
    message: "DeepSeek 响应超时，请稍后重试。",
    retryable: true,
    availability: "unavailable",
    httpStatus: 504,
  },
  invalid_response: {
    message: "DeepSeek 返回了驾驶舱无法识别的响应，请稍后重试。",
    retryable: true,
    availability: "unavailable",
    httpStatus: 502,
  },
  request_aborted: {
    message: "本次护航请求已取消。",
    retryable: true,
    availability: "unavailable",
    httpStatus: 499,
  },
};

export class ProviderError extends Error {
  constructor(code, message, options = {}) {
    const defaults = ERROR_DEFINITIONS[code] || ERROR_DEFINITIONS.provider_unavailable;
    super(message || defaults.message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? defaults.retryable;
    this.availability = options.availability || defaults.availability;
    this.httpStatus = options.httpStatus || defaults.httpStatus;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      availability: this.availability,
    };
  }
}

function errorForStatus(status) {
  if (status === 401) return new ProviderError("credential_invalid");
  if (status === 402) return new ProviderError("insufficient_balance");
  if (status === 429) return new ProviderError("rate_limited");
  if (status === 400 || status === 422) return new ProviderError("provider_request_invalid");
  return new ProviderError("provider_unavailable");
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((item) => item && VALID_ROLES.has(item.role) && typeof item.content === "string")
    .map((item) => ({ role: item.role, content: item.content.trim() }))
    .filter((item) => item.content);
}

export function createDeepSeekProvider({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model = DEFAULT_MODEL,
} = {}) {
  return {
    async complete({ apiKey, messages, maxTokens = 1024, signal } = {}) {
      if (typeof apiKey !== "string" || !apiKey) throw new ProviderError("credential_missing");
      const safeMessages = sanitizeMessages(messages);
      if (safeMessages.length === 0) throw new ProviderError("provider_request_invalid");

      const outputLimit = Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(Number(maxTokens)) || 1024));
      const controller = new AbortController();
      let timedOut = false;
      const relayAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) relayAbort();
      else signal?.addEventListener("abort", relayAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("provider timeout"));
      }, timeoutMs);
      timer.unref?.();

      try {
        const response = await fetchImpl(`${BASE_URL}${CHAT_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model,
            messages: safeMessages,
            thinking: { type: "disabled" },
            max_tokens: outputLimit,
            stream: false,
          }),
          signal: controller.signal,
        });

        const raw = await response.text();
        if (!response.ok) throw errorForStatus(response.status);

        let payload;
        try {
          payload = JSON.parse(raw.trim());
        } catch {
          throw new ProviderError("invalid_response");
        }
        const text = payload?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) throw new ProviderError("invalid_response");
        return { text: text.trim(), model: typeof payload.model === "string" ? payload.model : model };
      } catch (cause) {
        if (cause instanceof ProviderError) throw cause;
        if (timedOut) throw new ProviderError("timeout", undefined, { cause });
        if (signal?.aborted) throw new ProviderError("request_aborted", undefined, { cause });
        throw new ProviderError("network_error", undefined, { cause });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
      }
    },
  };
}
