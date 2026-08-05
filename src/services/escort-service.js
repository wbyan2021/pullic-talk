const PROVIDER = "deepseek";
const MASKED_DISPLAY = "••••••••（已安全保存）";
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 16;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_HISTORY_ITEMS = 12;
const MAX_HISTORY_TOTAL = 30_000;

const SYSTEM_PROMPT = [
  "你是 AI·OPS COCKPIT 的护航 AI。",
  "你的职责是用普通语言解释配置与连接状态、诊断问题，并给出当前最建议的下一步。",
  "当前 S01 没有任何工具调用或本机操作能力，你不能执行命令、安装软件、读取文件或修改配置。",
  "绝不能声称某个动作已经执行；需要操作时，明确告诉用户尚未执行，并给出安全步骤。",
  "即使 Pi 或其他 CLI Agent 不可用，你仍应继续提供独立的解释和诊断建议。",
].join("\n");

const ERROR_ACTIONS = {
  credential_missing: "接入 DeepSeek API Key",
  credential_invalid: "替换 API Key 后重新检测",
  insufficient_balance: "前往 DeepSeek 检查余额",
  rate_limited: "稍后重新检测",
  provider_request_invalid: "更新驾驶舱后重试",
  provider_unavailable: "稍后重新检测",
  network_error: "检查网络后重试",
  timeout: "稍后重新检测",
  invalid_response: "稍后重新检测",
  credential_store_unavailable: "检查 macOS 钥匙串后重试",
  unsupported_platform: "在 macOS 上使用安全凭据存储",
  busy: "等待当前请求完成",
  request_aborted: "重新发送请求",
  internal_error: "重新加载页面后重试",
};

const FALLBACK_MESSAGES = {
  invalid_credential_input: "API Key 格式无效，请检查后重新输入。",
  invalid_message: "请输入 1–8000 字的消息。",
  credential_missing: "尚未配置 DeepSeek API Key。",
  credential_invalid: "DeepSeek API Key 无效或已失效，请替换后重试。",
  insufficient_balance: "DeepSeek 账户余额不足，请充值后重试。",
  rate_limited: "DeepSeek 当前请求受限，请稍后重试。",
  provider_request_invalid: "驾驶舱与 DeepSeek 的请求协议不兼容，需要更新应用。",
  provider_unavailable: "DeepSeek 服务暂时不可用，请稍后重试。",
  network_error: "本机暂时无法连接 DeepSeek，请检查网络后重试。",
  timeout: "DeepSeek 响应超时，请稍后重试。",
  invalid_response: "DeepSeek 返回了驾驶舱无法识别的响应，请稍后重试。",
  credential_store_unavailable: "系统钥匙串暂时不可用，请检查 macOS 钥匙串状态后重试。",
  unsupported_platform: "当前凭据存储仅支持 macOS。",
  request_aborted: "本次护航请求已取消。",
  busy: "护航 AI 正在处理上一条请求，请稍候。",
  internal_error: "护航服务发生未知错误，请重新加载后重试。",
};

export class EscortServiceError extends Error {
  constructor(code, message = FALLBACK_MESSAGES[code] || FALLBACK_MESSAGES.internal_error, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "EscortServiceError";
    this.code = code;
    this.retryable = options.retryable ?? ["busy", "internal_error", "request_aborted"].includes(code);
    this.availability = options.availability || "unavailable";
    this.httpStatus = options.httpStatus || (code === "busy" ? 409 : 500);
    this.action = options.action || ERROR_ACTIONS[code] || ERROR_ACTIONS.internal_error;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      action: this.action,
      retryable: this.retryable,
    };
  }
}

function normalizeKey(apiKey) {
  if (typeof apiKey !== "string") throw new EscortServiceError("invalid_credential_input", undefined, { retryable: false, httpStatus: 400 });
  const value = apiKey.trim();
  if (value.length < MIN_KEY_LENGTH || value.length > MAX_KEY_LENGTH || /\s/.test(value)) {
    throw new EscortServiceError("invalid_credential_input", undefined, { retryable: false, httpStatus: 400 });
  }
  return value;
}

function normalizeMessage(message) {
  if (typeof message !== "string") throw new EscortServiceError("invalid_message", undefined, { retryable: false, httpStatus: 400 });
  const value = message.trim();
  if (!value || value.length > MAX_MESSAGE_LENGTH) {
    throw new EscortServiceError("invalid_message", undefined, { retryable: false, httpStatus: 400 });
  }
  return value;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const candidates = history
    .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, MAX_MESSAGE_LENGTH) }))
    .filter((item) => item.content)
    .slice(-MAX_HISTORY_ITEMS);

  const result = [];
  let total = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index];
    if (total + item.content.length > MAX_HISTORY_TOTAL) break;
    result.unshift(item);
    total += item.content.length;
  }
  return result;
}

function safeError(error) {
  if (error instanceof EscortServiceError) return error;
  const code = typeof error?.code === "string" ? error.code : "internal_error";
  const supported = new Set([
    "credential_missing", "credential_invalid", "insufficient_balance", "rate_limited",
    "provider_request_invalid", "provider_unavailable", "network_error", "timeout",
    "invalid_response", "credential_store_unavailable", "unsupported_platform", "request_aborted",
  ]);
  if (!supported.has(code)) return new EscortServiceError("internal_error", undefined, { cause: error });
  return new EscortServiceError(code, FALLBACK_MESSAGES[code], {
    cause: error,
    retryable: error?.retryable,
    availability: error?.availability || (code === "insufficient_balance" || code === "rate_limited" ? "limited" : "unavailable"),
    httpStatus: error?.httpStatus,
    action: ERROR_ACTIONS[code],
  });
}

export function createEscortService({ credentialStore, provider, now = () => new Date() }) {
  if (!credentialStore || !provider) throw new TypeError("credentialStore and provider are required");

  let initialized = false;
  let inFlight = false;
  let state = {
    availability: "unconfigured",
    lastCheckedAt: null,
    error: null,
  };

  const timestamp = () => {
    const value = now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };

  const publicStatus = (configured) => ({
    provider: PROVIDER,
    configured,
    display: configured ? MASKED_DISPLAY : null,
    availability: configured || state.error ? state.availability : "unconfigured",
    lastCheckedAt: state.lastCheckedAt,
    error: state.error,
  });

  const resetUnconfigured = () => {
    initialized = true;
    state = { availability: "unconfigured", lastCheckedAt: null, error: null };
    return publicStatus(false);
  };

  const setFailure = (error, configured = true) => {
    const safe = safeError(error);
    state = {
      availability: safe.availability,
      lastCheckedAt: configured ? timestamp() : null,
      error: safe.toJSON(),
    };
    initialized = true;
    return { safe, status: publicStatus(configured) };
  };

  const acquire = () => {
    if (inFlight) throw new EscortServiceError("busy", undefined, { retryable: true, httpStatus: 409 });
    inFlight = true;
  };

  return {
    async getStatus() {
      try {
        const configured = await credentialStore.has();
        if (!configured) return resetUnconfigured();
        if (!initialized || state.availability === "unconfigured") {
          initialized = true;
          state = { availability: "unchecked", lastCheckedAt: null, error: null };
        }
        return publicStatus(true);
      } catch (error) {
        return setFailure(error, false).status;
      }
    },

    async saveCredential(apiKey) {
      const value = normalizeKey(apiKey);
      try {
        await credentialStore.set(value);
      } catch (error) {
        throw safeError(error);
      }
      initialized = true;
      state = { availability: "unchecked", lastCheckedAt: null, error: null };
      return publicStatus(true);
    },

    async deleteCredential() {
      try {
        await credentialStore.delete();
      } catch (error) {
        throw safeError(error);
      }
      return resetUnconfigured();
    },

    async checkConnection({ signal } = {}) {
      acquire();
      try {
        const apiKey = await credentialStore.get();
        if (!apiKey) return resetUnconfigured();
        initialized = true;
        state = { availability: "checking", lastCheckedAt: state.lastCheckedAt, error: null };
        await provider.complete({
          apiKey,
          messages: [{ role: "user", content: "这是连接检测。请只回复 OK。" }],
          maxTokens: 8,
          signal,
        });
        state = { availability: "available", lastCheckedAt: timestamp(), error: null };
        return publicStatus(true);
      } catch (error) {
        return setFailure(error, true).status;
      } finally {
        inFlight = false;
      }
    },

    async sendMessage({ message, history, signal } = {}) {
      const userMessage = normalizeMessage(message);
      const safeHistory = sanitizeHistory(history);
      acquire();
      try {
        const apiKey = await credentialStore.get();
        if (!apiKey) {
          resetUnconfigured();
          throw new EscortServiceError("credential_missing", "尚未配置 DeepSeek API Key。", {
            retryable: false,
            availability: "unconfigured",
            httpStatus: 409,
          });
        }
        const result = await provider.complete({
          apiKey,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            ...safeHistory,
            { role: "user", content: userMessage },
          ],
          maxTokens: 1024,
          signal,
        });
        initialized = true;
        state = { availability: "available", lastCheckedAt: timestamp(), error: null };
        return {
          text: result.text,
          model: result.model,
          provider: PROVIDER,
          status: publicStatus(true),
        };
      } catch (error) {
        const { safe } = setFailure(error, error?.code !== "credential_missing");
        throw safe;
      } finally {
        inFlight = false;
      }
    },
  };
}
