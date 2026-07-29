import { AGENTS } from "../config.js";
import { activeProcs } from "../utils/process-registry.js";
import { log } from "../utils/log.js";
import { sanitizeChatRequest, callAgent, buildPrompt } from "../agent-caller.js";

export default function apiRoutes(app) {
  // 返回所有 agent 信息（前端动态渲染）
  app.get("/api/models", (req, res) => {
    const out = {};
    for (const [key, agent] of Object.entries(AGENTS)) {
      out[key] = { name: agent.name, model: agent.model, role: agent.role, color: agent.color, avatar: agent.avatar, models: Array.isArray(agent.models) ? agent.models : null };
    }
    res.json(out);
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, agents: Object.keys(AGENTS), activeProcs: activeProcs.size });
  });

  /**
   * POST /api/chat
   * body: { message, targets, history, thinking, mode }
   */
  app.post("/api/chat", async (req, res) => {
    const { error, data } = sanitizeChatRequest(req.body);
    if (error) return res.status(400).json({ error });

    const { message, targets, history, thinking, mode, models, rounds } = data;
    log(`📨 "${message.slice(0, 40)}${message.length > 40 ? "…" : ""}" → [${targets.join(", ")}] (${mode}/${thinking}/${rounds}轮)`);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // 客户端断开后不再写入（防止 write-after-close 报错）
    let clientClosed = false;
    const flush = (event, payload) => {
      if (clientClosed || res.writableEnded) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // 心跳
    const heartbeat = setInterval(() => {
      if (!clientClosed && !res.writableEnded) res.write(":keepalive\n\n");
    }, 15000);

    // 子进程注册表 + 断开清理
    const procs = [];
    const cleanup = () => {
      clientClosed = true;
      clearInterval(heartbeat);
      procs.forEach((p) => { try { p.kill("SIGTERM"); } catch {} });
      log("🔌 客户端断开，已终止本次请求的子进程");
    };
    res.on("close", cleanup);

    const chatCtx = { message, history, mode, rounds };
    flush("start", { message });

    const allResponses = []; // 跨轮累积所有 agent 发言，供下一轮参考
    for (let r = 0; r < rounds; r++) {
      if (r > 0) flush("round", { round: r + 1, total: rounds });
      if (clientClosed) break;

      if (mode === "collaborate") {
        // 协作模式：顺序调用，后者能看到前者 + 之前所有轮的发言
        const priorResponses = [...allResponses];
        for (const target of targets) {
          if (clientClosed) break; // 断开后不再白跑后续 agent
          flush("thinking", { agent: target });
          try {
            const fullText = await callAgent(target, buildPrompt(target, chatCtx, priorResponses), (chunk) => {
              flush("chunk", { agent: target, chunk });
            }, thinking, procs, models[target]);
            flush("done", { agent: target, text: fullText });
            priorResponses.push({ agent: target, text: fullText });
            allResponses.push({ agent: target, text: fullText });
          } catch (err) {
            flush("error", { agent: target, error: err.message });
          }
        }
      } else {
        // 并行模式：所有 agent 同时回答，下一轮能看到之前所有轮的发言
        const roundPrior = [...allResponses];
        const promises = targets.map(async (target) => {
          flush("thinking", { agent: target });
          try {
            const fullText = await callAgent(target, buildPrompt(target, chatCtx, roundPrior), (chunk) => {
              flush("chunk", { agent: target, chunk });
            }, thinking, procs, models[target]);
            flush("done", { agent: target, text: fullText });
            allResponses.push({ agent: target, text: fullText });
          } catch (err) {
            flush("error", { agent: target, error: err.message });
          }
        });
        await Promise.all(promises);
      }
    }

    clearInterval(heartbeat);
    res.removeListener("close", cleanup);
    flush("end", {});
    res.end();
  });
}
