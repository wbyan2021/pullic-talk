import { EscortServiceError } from "../services/escort-service.js";

const COST_WINDOW_MS = 60_000;
const COST_LIMIT = 12;
const MASKED_DISPLAY = "••••••••（已安全保存）";
const VALID_AVAILABILITY = new Set(["unconfigured", "unchecked", "checking", "available", "limited", "unavailable"]);

const SAFE_ERROR_DETAILS = {
  invalid_credential_input: ["API Key 格式无效，请检查后重新输入。", "重新输入 API Key", false],
  invalid_message: ["请输入 1–8000 字的消息。", "修改消息后重试", false],
  busy: ["护航 AI 正在处理上一条请求，请稍候。", "等待当前请求完成", true],
  credential_missing: ["尚未配置 DeepSeek API Key。", "接入 DeepSeek API Key", false],
  credential_invalid: ["DeepSeek API Key 无效或已失效，请替换后重试。", "替换 API Key 后重新检测", false],
  insufficient_balance: ["DeepSeek 账户余额不足，请充值后重试。", "前往 DeepSeek 检查余额", false],
  rate_limited: ["DeepSeek 当前请求受限，请稍后重试。", "稍后重新检测", true],
  credential_store_unavailable: ["系统钥匙串暂时不可用，请检查 macOS 钥匙串状态后重试。", "检查 macOS 钥匙串后重试", true],
  unsupported_platform: ["当前凭据存储仅支持 macOS。", "在 macOS 上使用安全凭据存储", false],
  network_error: ["本机暂时无法连接 DeepSeek，请检查网络后重试。", "检查网络后重试", true],
  provider_unavailable: ["DeepSeek 服务暂时不可用，请稍后重试。", "稍后重新检测", true],
  provider_request_invalid: ["驾驶舱与 DeepSeek 的请求协议不兼容，需要更新应用。", "更新驾驶舱后重试", false],
  invalid_response: ["DeepSeek 返回了驾驶舱无法识别的响应，请稍后重试。", "稍后重新检测", true],
  timeout: ["DeepSeek 响应超时，请稍后重试。", "稍后重新检测", true],
  request_aborted: ["本次护航请求已取消。", "重新发送请求", true],
  internal_error: ["护航服务暂时不可用，请重新加载后重试。", "重新加载页面", true],
};

const SAFE_HTTP_STATUS = {
  invalid_credential_input: 400,
  invalid_message: 400,
  busy: 409,
  credential_missing: 409,
  credential_invalid: 424,
  insufficient_balance: 424,
  rate_limited: 424,
  credential_store_unavailable: 424,
  unsupported_platform: 424,
  network_error: 502,
  provider_unavailable: 502,
  provider_request_invalid: 502,
  invalid_response: 502,
  timeout: 504,
  request_aborted: 499,
};

const UNKNOWN_ERROR = {
  ok: false,
  code: "internal_error",
  message: "护航服务暂时不可用，请重新加载后重试。",
  action: "重新加载页面",
  retryable: true,
};

function safeErrorDetails(code) {
  const safeCode = Object.hasOwn(SAFE_ERROR_DETAILS, code) ? code : "internal_error";
  const [message, action, retryable] = SAFE_ERROR_DETAILS[safeCode];
  return { code: safeCode, message, action, retryable };
}

function safeStatus(status = {}) {
  const configured = status.configured === true;
  const availability = VALID_AVAILABILITY.has(status.availability) ? status.availability : "unavailable";
  const error = status.error && typeof status.error === "object"
    ? safeErrorDetails(status.error.code)
    : null;
  return {
    provider: "deepseek",
    configured,
    display: configured ? MASKED_DISPLAY : null,
    availability,
    lastCheckedAt: typeof status.lastCheckedAt === "string" ? status.lastCheckedAt : null,
    error,
  };
}

function sendError(res, error) {
  if (!(error instanceof EscortServiceError) || !SAFE_HTTP_STATUS[error.code]) {
    return res.status(500).json(UNKNOWN_ERROR);
  }
  const details = safeErrorDetails(error.code);
  return res.status(SAFE_HTTP_STATUS[error.code]).json({
    ok: false,
    ...details,
  });
}

async function withClientAbort(res, operation) {
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error("client disconnected"));
  };
  res.once?.("close", onClose);
  try {
    return await operation(controller.signal);
  } finally {
    res.off?.("close", onClose);
  }
}

export default function escortRoutes(app, { escortService, now = () => Date.now() }) {
  if (!escortService) throw new TypeError("escortService is required");
  let costRequests = [];

  function consumeCostAllowance(res) {
    const current = now();
    costRequests = costRequests.filter((at) => current - at < COST_WINDOW_MS);
    if (costRequests.length >= COST_LIMIT) {
      res.status(429).json({
        ok: false,
        code: "local_rate_limited",
        message: "护航请求过于频繁，请稍后再试。",
        action: "等待一分钟后重试",
        retryable: true,
      });
      return false;
    }
    costRequests.push(current);
    return true;
  }

  app.get("/api/providers/deepseek/status", async (_req, res) => {
    try {
      const status = await escortService.getStatus();
      res.json({ ok: true, status: safeStatus(status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/providers/deepseek/credential", async (req, res) => {
    if (typeof req.body?.apiKey !== "string") {
      return res.status(400).json({
        ok: false,
        code: "invalid_credential_input",
        message: "请输入有效的 DeepSeek API Key。",
        action: "重新输入 API Key",
        retryable: false,
      });
    }
    try {
      const status = await escortService.saveCredential(req.body.apiKey);
      return res.json({ ok: true, status: safeStatus(status) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete("/api/providers/deepseek/credential", async (_req, res) => {
    try {
      const status = await escortService.deleteCredential();
      res.json({ ok: true, status: safeStatus(status) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/providers/deepseek/check", async (_req, res) => {
    if (!consumeCostAllowance(res)) return;
    try {
      const status = await withClientAbort(res, (signal) => escortService.checkConnection({ signal }));
      const publicStatus = safeStatus(status);
      res.json({ ok: publicStatus.availability === "available", status: publicStatus });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/escort/messages", async (req, res) => {
    if (!consumeCostAllowance(res)) return;
    try {
      const result = await withClientAbort(res, (signal) => escortService.sendMessage({
        message: req.body?.message,
        history: req.body?.history,
        signal,
      }));
      res.json({
        ok: true,
        reply: { text: result.text, model: result.model, provider: result.provider },
        status: safeStatus(result.status),
      });
    } catch (error) {
      sendError(res, error);
    }
  });
}
