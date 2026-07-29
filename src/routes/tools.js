import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import net from "net";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

const TOOLS_PATH = join(ROOT, "tools.json");

function probePort(port, host = "127.0.0.1", timeout = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.on("connect", () => done(true));
    s.on("timeout", () => done(false));
    s.on("error", () => done(false));
  });
}

function loadTools() {
  try { return JSON.parse(readFileSync(TOOLS_PATH, "utf-8")); }
  catch { return { version: 1, tools: [], services: {} }; }
}

export default function toolsRoutes(app) {
  // 返回工具清单 + 实时服务端口状态
  app.get("/api/tools", async (req, res) => {
    const data = loadTools();
    const services = {};
    for (const [name, info] of Object.entries(data.services || {})) {
      services[name] = { ...info, online: await probePort(info.port) };
    }
    res.json({ ...data, services });
  });

  // 重新扫描本机工具
  app.post("/api/tools/scan", (req, res) => {
    const proc = spawn("node", [join(ROOT, "scripts", "scan-tools.js")], { cwd: ROOT });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code === 0) res.json({ ok: true, output: out });
      else res.status(500).json({ ok: false, output: out, error: err });
    });
  });
}
