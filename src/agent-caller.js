import { spawn } from "child_process";
import { AGENTS } from "./config.js";
import { LIMITS, VALID_THINKING, VALID_MODES, MAX_OUTPUT_BYTES } from "./limits.js";
import { activeProcs } from "./utils/process-registry.js";
import { log } from "./utils/log.js";

// ===== 工具函数：按点路径取嵌套值 =====
export function getNestedValue(obj, path) {
  if (!path) return undefined;
  return path.split(".").reduce((o, k) => o?.[isNaN(k) ? k : parseInt(k)], obj);
}

// ===== 通用 Agent 调用器 =====
export function callAgent(agentKey, prompt, onChunk, thinking, procs, modelOverride) {
  const agent = AGENTS[agentKey];
  if (!agent) return Promise.resolve("");

  const cli = agent.cli;
  const stdioMode = cli.stdio === "ignore" ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];

  const modelValue = modelOverride || agent.model || "";
  const args = [];
  for (const a of cli.args) {
    if (a === "{prompt}") { args.push(prompt); continue; }
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
    const env = { ...process.env };
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

    let buffer = "";
    let fullText = "";
    let stderrText = "";
    let timedOut = false;
    let outputExceeded = false;
    let killTimer = null; // SIGTERM 后补 SIGKILL 的定时器（需随进程退出清理）

    // 输出超过上限时截断，并杀进程防内存爆炸
    const trackOutput = (s) => {
      if (fullText.length + buffer.length > MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        log(`⚠️ ${agentKey} 输出超过 ${MAX_OUTPUT_BYTES / 1024}KB，已截断并终止`);
        try { proc.kill("SIGTERM"); } catch {}
      }
    };

    const timeoutMs = cli.timeoutMs || LIMITS.procTimeoutMs;
    const killer = setTimeout(() => {
      timedOut = true;
      log(`⏰ ${agentKey} 超时（${timeoutMs / 1000}s），强制终止`);
      try { proc.kill("SIGTERM"); } catch {}
      killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
    }, timeoutMs);

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
        if (text) { fullText += text; onChunk(text); }
      } catch {
        fullText += trimmed;
        onChunk(trimmed + "\n");
      }
    };

    proc.stdout.on("data", (data) => {
      const raw = data.toString();
      trackOutput(raw);
      switch (cli.parseMode) {
        case "ndjson":
          buffer += raw;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) consumeNdjsonLine(line);
          break;
        case "text":
          fullText += raw;
          onChunk(raw);
          break;
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
      clearTimeout(killer);
      if (killTimer) clearTimeout(killTimer);
      if (cli.parseMode === "ndjson" && buffer.trim()) {
        consumeNdjsonLine(buffer);
        buffer = "";
      }
      if (cli.parseMode === "json-envelope") {
        try {
          const evt = JSON.parse(buffer.trim());
          const text = getNestedValue(evt, cli.jsonTextField) || evt.text || "";
          if (text) { onChunk(text); resolve(text); }
          else { onChunk("⚠️ 未返回文本\n"); resolve(""); }
        } catch {
          if (buffer.trim()) { onChunk(buffer); resolve(buffer); }
          else { onChunk(`⚠️ ${agent.name} 错误: ${stderrText.slice(0, 200)}\n`); resolve(""); }
        }
      } else {
        if (outputExceeded) {
          onChunk(`\n⚠️ 输出过长，已截断\n`);
          fullText += "\n\n（输出过长已截断）";
        } else if (timedOut && !fullText) {
          onChunk(`⚠️ ${agent.name} 响应超时（${timeoutMs / 1000}s）\n`);
        } else if (!fullText && stderrText) {
          onChunk(`⚠️ ${agent.name} 错误: ${stderrText.slice(0, 200)}\n`);
        }
        resolve(fullText);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(killer);
      if (killTimer) clearTimeout(killTimer);
      const reason = err.code === "ENOENT" ? "CLI 未安装或不在 PATH" : err.message;
      onChunk(`⚠️ ${agent.name} 不可用（${reason}）\n`);
      resolve("");
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

  let targets = Array.isArray(body.targets) ? body.targets : [];
  targets = [...new Set(targets)]
    .filter((t) => typeof t === "string" && AGENTS[t])
    .slice(0, LIMITS.maxTargets);
  if (targets.length === 0) targets = Object.keys(AGENTS);
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

// ===== 构建带上下文的 prompt（带长度保护） =====
export function buildPrompt(agentKey, { message, history, mode, rounds }, priorResponses) {
  const parts = [];

  const discuss = mode === "collaborate" || rounds > 1;
  if (discuss && AGENTS[agentKey]?.persona) {
    parts.push(AGENTS[agentKey].persona);
  }

  if (history.length > 0) {
    const lines = [];
    let total = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const line = `[${history[i].sender}]: ${history[i].text}`;
      if (total + line.length > LIMITS.historyTotalMaxLen) break;
      lines.unshift(line);
      total += line.length;
    }
    if (lines.length > 0) parts.push("以下是群聊上下文：\n\n" + lines.join("\n\n"));
  }

  if (priorResponses.length > 0) {
    let respText = "其他 AI 已经给出了以下回复：\n\n";
    for (const resp of priorResponses) {
      const name = AGENTS[resp.agent]?.name || resp.agent;
      respText += `[${name}]: ${resp.text.slice(0, LIMITS.historyItemMaxLen)}\n\n`;
    }
    respText += `请基于以上回复，给出补充、回应或不同意见。用户消息: ${message}`;
    parts.push(respText);
  } else {
    parts.push(`用户消息: ${message}`);
  }

  let prompt = parts.join("\n\n");
  if (prompt.length > LIMITS.promptMaxLen) {
    prompt = prompt.slice(0, LIMITS.promptMaxLen) + "\n\n（注：上下文过长已截断）";
  }
  return prompt;
}
