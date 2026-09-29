import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { AGENTS } from "./config.js";
import { LIMITS, VALID_THINKING, VALID_MODES, MAX_OUTPUT_BYTES } from "./limits.js";
import { activeProcs } from "./utils/process-registry.js";
import { log } from "./utils/log.js";

// ===== 工具函数：按点路径取嵌套值 =====
export function getNestedValue(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((o, k) => o?.[isNaN(k) ? k : parseInt(k)], obj);
}

// 子进程被显式给了 TERM/COLORTERM（部分 CLI 只看这两个环境变量就决定上色），
// 而页面渲染的是 Markdown/纯文本：转义序列既不可读又可能破坏 DOM，一律在进入输出流前去掉。
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function stripAnsi(value) {
  return value.includes("\x1b") ? value.replace(ANSI_RE, "") : value;
}

// 上游 CLI 的启动噪声不是失败原因。此前这三条硬编码在两个结算分支里各写一遍；
// 收敛成一处，并允许成员配置用 cli.stderrIgnore 覆盖（字符串=行首前缀，RegExp=自定义匹配）。
const DEFAULT_STDERR_IGNORE = ["Warning:", "Skill conflict", "Ripgrep"];

// ===== 通用 Agent 调用器 =====
export function callAgent(agentKey, prompt, onChunk, thinking, procs, modelOverride) {
  const agent = AGENTS[agentKey];
  if (!agent) return Promise.resolve("");

  const cli = agent.cli;
  const stdioMode = cli.stdio === "ignore" ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
  const ignore = (Array.isArray(cli.stderrIgnore) ? cli.stderrIgnore : DEFAULT_STDERR_IGNORE)
    .map((entry) => (entry instanceof RegExp
      ? { re: entry }
      : (typeof entry === "string" ? { prefix: entry } : null)))
    .filter(Boolean);
  const isNoise = (line) => ignore.some((rule) => (rule.prefix ? line.startsWith(rule.prefix) : rule.re.test(line)));
  // 去掉启动噪声后若什么都不剩，就回退到原文：宁可啰嗦，也不吞掉真实错误
  const usefulError = (text) => stripAnsi(text.split("\n").filter((line) => !isNoise(line)).join("\n").trim() || text);

  const modelValue = modelOverride || agent.model || "";
  // {prompt} 在模板中是否为位置参数（前一元素不是选项）：位置参数且 prompt 以 - 开头时
  // 插入 "--" 终止符，防止用户消息被 CLI 当作选项解析（如 "-h"、"--verbose 你好"）
  const promptIdx = cli.args.indexOf("{prompt}");
  const promptIsPositional = promptIdx <= 0 || !cli.args[promptIdx - 1].startsWith("-");
  const args = [];
  for (const a of cli.args) {
    if (a === "{prompt}") {
      if (promptIsPositional && typeof prompt === "string" && prompt.startsWith("-")) args.push("--");
      args.push(prompt);
      continue;
    }
    if (a === "{model}") {
      if (modelValue) args.push(modelValue);
      // 无模型值时删掉配套的 flag：仅当前一个是选项（以 - 开头）才 pop，避免误删位置参数
      else if (args.length && args[args.length - 1].startsWith("-")) args.pop();
      continue;
    }
    args.push(a);
  }

  if (thinking && cli.thinkingFlag && cli.thinkingMap?.[thinking]) {
    args.push(cli.thinkingFlag, cli.thinkingMap[thinking]);
  }

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    if (cli.env) Object.assign(env, cli.env);

    let proc;
    try {
      proc = spawn(cli.command, args, { cwd: process.env.HOME, env, stdio: stdioMode });
    } catch (err) {
      onChunk(`⚠️ ${agent.name} 启动失败（${err.message}）\n`);
      return resolve("");
    }
    if (procs) procs.push(proc);
    activeProcs.add(proc);
    proc.on("close", () => activeProcs.delete(proc));

    // prompt 始终通过 args 传入：对 stdin 为 pipe 的 agent 立刻给 EOF，
    // 避免 CLI 等待一个永远不会有数据的 stdin 而挂起直至超时
    if (stdioMode[0] === "pipe") {
      try { proc.stdin.end(); } catch {}
    }

    let buffer = "";
    let fullText = "";
    let stderrText = "";
    let timedOut = false;
    let outputExceeded = false;
    let settled = false; // spawn 失败会先 error 后 close，只允许结算一次
    let rawBytes = 0;   // 原始输出字节：ndjson 被过滤的行也计数，防失控进程绕过输出上限
    let killTimer = null; // SIGTERM 后补 SIGKILL 的定时器（需随进程退出清理）

    const timeoutMs = cli.timeoutMs || LIMITS.procTimeoutMs;
    const killer = setTimeout(() => {
      timedOut = true;
      log(`⏰ ${agentKey} 超时（${timeoutMs / 1000}s），强制终止`);
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
    }, timeoutMs);

    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
    const clearTimers = () => { clearTimeout(killer); if (killTimer) clearTimeout(killTimer); };

    // 输出超过上限时截断并杀进程（按原始字节计，先计数再判断，避免滞后一个 chunk）
    const trackOutput = (n) => {
      rawBytes += n;
      if (rawBytes > MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        log(`⚠️ ${agentKey} 输出超过 ${MAX_OUTPUT_BYTES / 1024}KB，已截断并终止`);
        try { proc.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
      }
    };

    // textType / textField(s) 均支持字符串或数组（数组按序尝试）
    const textTypes = cli.textType ? [cli.textType].flat() : null;
    const textFields = [cli.textField || cli.textFields || []].flat().filter(Boolean);
    const consumeNdjsonLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        if (textTypes && !textTypes.includes(evt.type)) return;
        let text = "";
        for (const f of textFields) { text = getNestedValue(evt, f); if (text) break; }
        text = text || evt.text || evt.data || "";
        if (text) {
          if (typeof text !== "string") text = JSON.stringify(text); // 结构化值转 JSON，不产出 [object Object]
          text = stripAnsi(text);
          if (!text) return;
          fullText += text;
          onChunk(text);
        }
      } catch {
        const plain = stripAnsi(trimmed);
        if (!plain) return;
        fullText += plain;
        onChunk(plain + "\n");
      }
    };

    // 增量解码：中文等多字节字符跨 chunk 边界时不会产生替换符
    const outDecoder = new StringDecoder("utf8");
    proc.stdout.on("data", (data) => {
      const raw = outDecoder.write(data);
      trackOutput(data.length);
      if (!raw) return;
      switch (cli.parseMode) {
        case "ndjson":
          buffer += raw;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) consumeNdjsonLine(line);
          break;
        case "text": {
          const plain = stripAnsi(raw);
          if (!plain) break;
          fullText += plain;
          onChunk(plain);
          break;
        }
        case "json-envelope":
          buffer += raw;
          break;
      }
    });

    proc.stderr.on("data", (data) => {
      // stderr 同样截断，避免无界增长
      if (stderrText.length < 64 * 1024) stderrText += data.toString();
    });

    proc.on("close", () => {
      clearTimers();
      if (cli.parseMode === "ndjson" && buffer.trim()) {
        consumeNdjsonLine(buffer);
        buffer = "";
      }
      if (settled) return; // error 事件已结算（如 ENOENT），close 不再重复输出
      if (cli.parseMode === "json-envelope") {
        // 超时/超限截断出的半截 JSON 不能当答案返回
        if (outputExceeded) { onChunk(`\n⚠️ 输出过长，已截断\n`); return settle(""); }
        if (timedOut) { onChunk(`\n⚠️ ${agent.name} 响应超时（${timeoutMs / 1000}s），已截断\n`); return settle(""); }
        try {
          const evt = JSON.parse(buffer.trim());
          const text = stripAnsi(getNestedValue(evt, cli.jsonTextField) || evt.text || "");
          if (text) { onChunk(text); settle(text); }
          else { onChunk("⚠️ 未返回文本\n"); settle(""); }
        } catch {
          if (buffer.trim()) { const raw = stripAnsi(buffer); onChunk(raw); settle(raw); }
          else {
            onChunk(`⚠️ ${agent.name} 错误: ${usefulError(stderrText).slice(0, 300)}\n`);
            settle("");
          }
        }
      } else {
        if (outputExceeded) {
          onChunk(`\n⚠️ 输出过长，已截断\n`);
          fullText += "\n\n（输出过长已截断）";
        } else if (timedOut && fullText) {
          onChunk(`\n⏰ ${agent.name} 超时（${timeoutMs / 1000}s），以上为部分输出\n`);
          fullText += "\n\n（超时截断）";
        } else if (timedOut && !fullText) {
          onChunk(`⚠️ ${agent.name} 响应超时（${timeoutMs / 1000}s）\n`);
        } else if (!fullText && stderrText) {
          onChunk(`⚠️ ${agent.name} 错误: ${usefulError(stderrText).slice(0, 300)}\n`);
        }
        settle(fullText);
      }
    });

    proc.on("error", (err) => {
      clearTimers();
      const reason = err.code === "ENOENT" ? "CLI 未安装或不在 PATH" : err.message;
      onChunk(`⚠️ ${agent.name} 不可用（${reason}）\n`);
      settle("");
    });
  });
}

// ===== 输入清洗 =====
export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-LIMITS.historyMaxItems)
    .filter((m) => m && typeof m.text === "string" && m.text.trim())
    .map((m) => ({
      sender: String(m.sender || "?").slice(0, 40),
      text: m.text.slice(0, LIMITS.historyItemMaxLen),
    }));
}

export function sanitizeChatRequest(body) {
  if (!body || typeof body !== "object") return { error: "请求体格式错误" };

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return { error: "消息不能为空" };
  if (message.length > LIMITS.messageMaxLen) {
    return { error: `消息过长（>${LIMITS.messageMaxLen} 字符）` };
  }

  const requested = [...new Set(Array.isArray(body.targets) ? body.targets : [])]
    .filter((t) => typeof t === "string");
  let targets = requested
    .filter((t) => Object.prototype.hasOwnProperty.call(AGENTS, t))
    .slice(0, LIMITS.maxTargets);
  if (targets.length === 0) {
    // 客户端确实点了名、却一个都不认识（成员刚被停用 / 配置改了 / 页面状态过期）：
    // 必须报错。静默退化成"向本机全部 CLI 广播"会悄悄烧掉最多 8 个账号的额度。
    if (requested.length > 0) return { error: "targets 里没有可用的成员，请刷新页面后重试" };
    targets = Object.keys(AGENTS); // 没点名 = 按产品语义发给所有可用成员
  }
  if (targets.length === 0) return { error: "当前没有可用的 agent" };

  const thinking = VALID_THINKING.has(body.thinking) ? body.thinking : "medium";
  const mode = VALID_MODES.has(body.mode) ? body.mode : "parallel";
  const history = sanitizeHistory(body.history);

  let rounds = Math.floor(Number(body.rounds));
  if (!Number.isFinite(rounds)) rounds = 1;
  rounds = Math.max(1, Math.min(rounds, LIMITS.maxRounds));

  const models = {};
  if (body.models && typeof body.models === "object") {
    for (const [k, v] of Object.entries(body.models)) {
      const agent = AGENTS[k];
      if (!agent || typeof v !== "string" || v.length > 100) continue;
      if (Array.isArray(agent.models) && agent.models.includes(v)) models[k] = v;
    }
  }

  return { data: { message, targets, history, thinking, mode, models, rounds } };
}

// ===== 构建带上下文的 prompt（带长度保护）=====
export function buildPrompt(agentKey, { message, history, mode, rounds }, priorResponses) {
  const parts = [];

  const discuss = mode === "collaborate" || rounds > 1;
  if (discuss && AGENTS[agentKey]?.persona) {
    parts.push(AGENTS[agentKey].persona);
  }

  if (history.length > 0) {
    // 防御性去重：部分客户端会把「刚发出的这条消息」一并带进 history，
    // 末尾若恰好是同一条用户消息则跳过，避免它在 prompt 中出现两次
    const hist = [...history];
    const lastMsg = hist[hist.length - 1];
    if (lastMsg && lastMsg.sender === "你" && lastMsg.text === message) hist.pop();

    const lines = [];
    let total = 0;
    for (let i = hist.length - 1; i >= 0; i--) {
      const line = `[${hist[i].sender}]: ${hist[i].text}`;
      if (total + line.length > LIMITS.historyTotalMaxLen) break;
      lines.unshift(line);
      total += line.length;
    }
    if (lines.length > 0) parts.push("以下是群聊上下文：\n\n" + lines.join("\n\n"));
  }

  // 用户消息永远单独放最后：兜底截断时优先保住 persona 和用户问题
  const messageLine = priorResponses.length > 0
    ? `请基于以上回复，给出补充、回应或不同意见。用户消息: ${message}`
    : `用户消息: ${message}`;

  if (priorResponses.length > 0) {
    // 从最新往回填配额：多轮×多目标时旧回复先被丢弃，而不是把用户消息截掉
    const respLines = [];
    let total = 0;
    for (let i = priorResponses.length - 1; i >= 0; i--) {
      const resp = priorResponses[i];
      const name = AGENTS[resp.agent]?.name || resp.agent;
      const line = `[${name}]: ${resp.text.slice(0, LIMITS.historyItemMaxLen)}`;
      if (total + line.length > LIMITS.historyTotalMaxLen) break;
      respLines.unshift(line);
      total += line.length;
    }
    parts.push("其他 AI 已经给出了以下回复：\n\n" + respLines.join("\n\n"));
  }

  let prompt = parts.length > 0 ? parts.join("\n\n") + "\n\n" + messageLine : messageLine;
  if (prompt.length > LIMITS.promptMaxLen) {
    // 头部超限时压缩中间节（历史/回复），仍保不住再截头，用户消息始终在尾部完整保留
    const overflow = prompt.length - LIMITS.promptMaxLen;
    const head = parts.length > 0 ? parts.join("\n\n") : "";
    const trimmedHead = head.length > overflow ? head.slice(0, Math.max(0, head.length - overflow)) : head;
    prompt = trimmedHead + "\n\n（注：上下文过长已截断）\n\n" + messageLine;
  }
  return prompt;
}
