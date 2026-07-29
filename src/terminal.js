import pty from "node-pty";
import { log } from "./utils/log.js";

const activePtys = new Set();

export function setupTerminal(wss) {
  wss.on("connection", (ws) => {
    const shell = process.env.SHELL || "/bin/zsh";
    let term;
    try {
      term = pty.spawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: 120, rows: 32,
        cwd: process.env.HOME, env: process.env,
      });
    } catch (e) {
      ws.send(JSON.stringify({ type: "output", data: `\r\n\x1b[31m终端启动失败: ${e.message}\x1b[0m\r\n` }));
      ws.close();
      return;
    }
    activePtys.add(term);
    log(`💻 终端会话已开启 (pid ${term.pid})`);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "hello", pid: term.pid, shell }));

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    });
    term.onExit(({ exitCode }) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", code: exitCode }));
      activePtys.delete(term);
      log(`💻 终端会话结束 (code ${exitCode})`);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      switch (msg.type) {
        case "input": if (typeof msg.data === "string") term.write(msg.data); break;
        case "resize":
          if (Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            try { term.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); } catch {}
          }
          break;
        case "run":
          // 在终端中执行一条命令（用于"一键启动"注入）
          if (typeof msg.command === "string") term.write(msg.command + "\n");
          break;
        case "reset":
          try { term.kill(); } catch {}
          break;
      }
    });

    ws.on("close", () => {
      try { term.kill(); } catch {}
      activePtys.delete(term);
    });
  });
}

export function getActivePtys() {
  return activePtys;
}
