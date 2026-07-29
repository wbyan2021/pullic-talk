import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER = process.env.SERVER || "http://localhost:3210";
const DIVIDER = "─".repeat(60);

// 加载辩论配置
const debateConfig = JSON.parse(readFileSync(join(__dirname, "debate.json"), "utf-8")).debate;

// 加载 agent 配置
const agentConfig = JSON.parse(readFileSync(join(__dirname, "agents.config.json"), "utf-8"));

// 辩论历史记录
const debateHistory = [];

// ===== 启动前检查 server 是否在线 =====
async function checkServer() {
  try {
    const res = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (!data.ok) throw new Error("health check failed");
    return data.agents || [];
  } catch {
    console.error(`\n❌ 无法连接服务器 ${SERVER}`);
    console.error(`   请先运行: node server.js\n`);
    process.exit(1);
  }
}

// ===== 格式化整场辩论记录（用于 {debate_history} 占位符） =====
function formatDebateHistory() {
  if (debateHistory.length === 0) return "（暂无）";
  return debateHistory
    .map((e) => `【Round ${e.round} ${e.roundTitle} · ${e.side} ${e.name}】\n${e.text}`)
    .join("\n\n");
}

// ===== 替换 prompt 中的占位符 =====
function renderPrompt(template) {
  let prompt = template;
  if (prompt.includes("{opponent_previous}")) {
    const last = debateHistory[debateHistory.length - 1];
    prompt = prompt.replaceAll("{opponent_previous}", last ? last.text : "（对方尚未发言）");
  }
  if (prompt.includes("{debate_history}")) {
    prompt = prompt.replaceAll("{debate_history}", formatDebateHistory());
  }
  return prompt;
}

// 调用 agent（流式输出到终端）
async function callAgent(agentKey, prompt) {
  const agent = agentConfig[agentKey];
  if (!agent) {
    console.error(`❌ Agent ${agentKey} 不在 agents.config.json 中`);
    return "";
  }

  console.log(`\n${DIVIDER}`);
  console.log(`🤖 ${agent.name} (${agentKey}) 正在发言…`);
  console.log(`${DIVIDER}\n`);

  try {
    const response = await fetch(`${SERVER}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: prompt,
        targets: [agentKey],
        history: [],
        thinking: "medium",
        mode: "parallel",
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error(`❌ 请求被拒绝: ${err.error || response.status}`);
      return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const evtStr of events) {
        const lines = evtStr.split("\n");
        let eventType = "";
        let data = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          if (line.startsWith("data: ")) data = line.slice(6);
        }

        if (!eventType || !data || eventType.startsWith(":")) continue;

        try {
          const parsed = JSON.parse(data);
          if (eventType === "chunk") {
            process.stdout.write(parsed.chunk);
            fullText += parsed.chunk;
          } else if (eventType === "done") {
            fullText = parsed.text || fullText;
          } else if (eventType === "error") {
            console.error(`\n⚠️ ${parsed.error}`);
          }
        } catch {}
      }
    }

    return fullText;
  } catch (error) {
    console.error(`\n❌ 调用 ${agentKey} 失败:`, error.message);
    return "";
  }
}

// ===== 输出文件（实时增量写入，中断也不丢） =====
const outDir = join(__dirname, "debates");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `debate-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`);

function appendToFile(text) {
  appendFileSync(outFile, text, "utf-8");
}

// 运行辩论
async function runDebate() {
  const availableAgents = await checkServer();

  // 校验辩论双方 agent 是否存在
  for (const [side, role] of Object.entries(debateConfig.roles)) {
    if (!agentConfig[role.agent]) {
      console.error(`❌ ${side} agent "${role.agent}" 不在 agents.config.json 中`);
      process.exit(1);
    }
    if (!availableAgents.includes(role.agent)) {
      console.error(`⚠️ ${side} agent "${role.agent}" 未在服务器注册（配置热加载可能未生效）`);
    }
  }

  const header = [
    "",
    "🎬".repeat(20),
    "  奇葩说风格 AI 辩论",
    "🎬".repeat(20),
    "",
    `辩题：${debateConfig.topic}`,
    "",
    `正方 (${debateConfig.roles["正方"].name})：${debateConfig.roles["正方"].stance}`,
    `反方 (${debateConfig.roles["反方"].name})：${debateConfig.roles["反方"].stance}`,
    "",
  ].join("\n");
  console.log(header);

  appendToFile(`# AI 辩论赛\n\n> 辩题：${debateConfig.topic}\n>\n`);
  appendToFile(`> 正方 (${debateConfig.roles["正方"].name})：${debateConfig.roles["正方"].stance}\n`);
  appendToFile(`> 反方 (${debateConfig.roles["反方"].name})：${debateConfig.roles["反方"].stance}\n\n---\n\n`);

  for (const round of debateConfig.rounds) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Round ${round.round}: ${round.title}`);
    console.log(`${"═".repeat(60)}`);
    console.log(`${round.description}\n`);

    appendToFile(`## Round ${round.round}: ${round.title}\n\n`);

    for (const side of round.order) {
      const role = debateConfig.roles[side];
      const agentKey = role.agent;
      const prompt = renderPrompt(round.prompts[side]);

      const response = await callAgent(agentKey, prompt);
      debateHistory.push({
        round: round.round,
        roundTitle: round.title,
        side,
        agent: agentKey,
        name: role.name,
        text: response,
      });

      appendToFile(`### ${side} · ${role.name}\n\n${response}\n\n`);
      console.log("\n");
    }
  }

  const footer = [
    "",
    "🏆".repeat(20),
    "  辩论结束",
    "🏆".repeat(20),
    "",
  ].join("\n");
  console.log(footer);
  console.log(`📄 完整记录已保存: ${outFile}\n`);

  appendToFile(`---\n\n*辩论于 ${new Date().toLocaleString("zh-CN")} 结束*\n`);
}

runDebate().catch((e) => {
  console.error("❌ 辩论运行出错:", e);
  process.exit(1);
});
