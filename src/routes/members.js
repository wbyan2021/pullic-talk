import { AGENTS, getUserConfigRaw, writeUserConfig, reloadConfig, getAvailability } from "../config.js";
import { AGENT_CATALOG } from "../agent-catalog.js";
import { log } from "../utils/log.js";

const KEY_RE = /^[a-z0-9_-]{1,30}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const PARSE_MODES = new Set(["text", "ndjson", "json-envelope"]);
const STDIO_MODES = new Set(["ignore", "pipe"]);

class Bad extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanStr(v, { max = 200, required = false, field = "value" } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Bad(400, `${field} 不能为空`);
    return undefined;
  }
  if (typeof v !== "string") throw new Bad(400, `${field} 必须是字符串`);
  const s = v.trim();
  if (!s) {
    if (required) throw new Bad(400, `${field} 不能为空`);
    return undefined;
  }
  if (s.length > max) throw new Bad(400, `${field} 过长（>${max}）`);
  return s;
}

function cleanModels(v) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Bad(400, "models 必须是数组");
  const out = [];
  for (const m of v) {
    if (typeof m !== "string" || !m.trim() || m.length > 120) {
      throw new Bad(400, "models 里包含非法模型名");
    }
    out.push(m.trim());
  }
  if (out.length > 40) throw new Bad(400, "模型数量过多（>40）");
  return out;
}

function cleanCli(cli, { requireCommand = false } = {}) {
  if (cli === undefined || cli === null) return undefined;
  if (typeof cli !== "object" || Array.isArray(cli)) throw new Bad(400, "cli 必须是对象");

  const out = {};
  const command = cleanStr(cli.command, { max: 100, field: "cli.command" });
  if (command !== undefined) out.command = command;
  if (out.command === undefined && requireCommand) throw new Bad(400, "cli.command 不能为空");

  if (cli.args !== undefined) {
    if (!Array.isArray(cli.args)) throw new Bad(400, "cli.args 必须是数组");
    out.args = cli.args.map((a, i) => {
      if (typeof a !== "string" || a.length > 300) throw new Bad(400, `cli.args[${i}] 非法`);
      return a;
    });
    if (out.args.length > 40) throw new Bad(400, "cli.args 过多（>40）");
  }

  const parseMode = cli.parseMode === undefined ? undefined : String(cli.parseMode);
  if (parseMode !== undefined && !PARSE_MODES.has(parseMode)) {
    throw new Bad(400, `cli.parseMode 仅支持 ${[...PARSE_MODES].join("/")}`);
  }
  if (parseMode !== undefined) out.parseMode = parseMode;

  const stdio = cli.stdio === undefined ? undefined : String(cli.stdio);
  if (stdio !== undefined && !STDIO_MODES.has(stdio)) {
    throw new Bad(400, `cli.stdio 仅支持 ${[...STDIO_MODES].join("/")}`);
  }
  if (stdio !== undefined) out.stdio = stdio;

  const thinkingFlag = cleanStr(cli.thinkingFlag, { max: 60, field: "cli.thinkingFlag" });
  if (thinkingFlag !== undefined) out.thinkingFlag = thinkingFlag;

  if (cli.thinkingMap !== undefined) {
    if (typeof cli.thinkingMap !== "object" || Array.isArray(cli.thinkingMap)) {
      throw new Bad(400, "cli.thinkingMap 必须是对象");
    }
    for (const [k, v] of Object.entries(cli.thinkingMap)) {
      if (typeof v !== "string" || v.length > 60) throw new Bad(400, "cli.thinkingMap 值非法");
    }
    out.thinkingMap = { ...cli.thinkingMap };
  }

  for (const f of ["textField", "textType", "jsonTextField"]) {
    if (cli[f] !== undefined) out[f] = cli[f];
  }
  for (const f of ["textFields"]) {
    if (cli[f] !== undefined) out[f] = cli[f];
  }
  const timeoutMs = Number(cli.timeoutMs);
  if (cli.timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
      throw new Bad(400, "cli.timeoutMs 必须在 1000–600000 之间");
    }
    out.timeoutMs = timeoutMs;
  }

  if (cli.env !== undefined) {
    if (typeof cli.env !== "object" || Array.isArray(cli.env)) throw new Bad(400, "cli.env 必须是对象");
    out.env = { ...cli.env };
  }

  return out;
}

// 从请求体构造可写入 agents.config.json 的成员条目（只允许白名单字段）
function buildMemberPatch(body, { requireCli = false } = {}) {
  const patch = {};

  const name = cleanStr(body.name, { max: 40, field: "name" });
  if (name !== undefined) patch.name = name;

  const role = cleanStr(body.role, { max: 80, field: "role" });
  if (role !== undefined) patch.role = role;

  const model = cleanStr(body.model, { max: 120, field: "model" });
  if (model !== undefined) patch.model = model;

  const models = cleanModels(body.models);
  if (models !== undefined) patch.models = models;

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new Bad(400, "enabled 必须是布尔值");
    patch.enabled = body.enabled;
  }

  const color = cleanStr(body.color, { max: 7, field: "color" });
  if (color !== undefined) {
    if (!COLOR_RE.test(color)) throw new Bad(400, "color 必须是 #RRGGBB");
    patch.color = color;
  }

  const avatar = cleanStr(body.avatar, { max: 4, field: "avatar" });
  if (avatar !== undefined) patch.avatar = avatar;

  const cli = cleanCli(body.cli, { requireCommand: requireCli });
  if (cli !== undefined) patch.cli = cli;

  return patch;
}

function memberView(key) {
  const agent = AGENTS[key];
  const builtin = !!AGENT_CATALOG[key];
  const raw = getUserConfigRaw();
  const rawEntry = raw[key] || {};
  const base = agent || rawEntry || AGENT_CATALOG[key] || {};
  const avail = agent ? getAvailability().get(key) : null;
  return {
    key,
    name: base.name || key,
    role: base.role || "",
    model: base.model || "",
    models: Array.isArray(base.models) ? base.models : null,
    color: base.color || "#71717a",
    avatar: base.avatar || key.slice(0, 1).toUpperCase(),
    source: agent?.source || "builtin",
    builtin,
    enabled: !!agent,
    available: !!(avail?.available),
    cliCommand: base.cli?.command || null,
  };
}

export default function membersRoutes(app) {
  // 成员列表：包含已停用的成员，方便用户重新启用
  app.get("/api/members", (req, res) => {
    const raw = getUserConfigRaw();
    const keys = new Set([...Object.keys(AGENT_CATALOG), ...Object.keys(raw)]);
    const members = {};
    for (const key of keys) members[key] = memberView(key);
    res.json({ ok: true, members });
  });

  // 添加自定义成员
  app.post("/api/members", (req, res) => {
    try {
      const body = req.body || {};
      const key = cleanStr(body.key, { max: 30, field: "key" });
      if (!key || !KEY_RE.test(key)) {
        throw new Bad(400, "key 仅允许小写字母/数字/下划线/连字符（1–30 位）");
      }
      const raw = getUserConfigRaw();
      if (AGENT_CATALOG[key] || raw[key]) throw new Bad(409, "成员已存在");

      const patch = buildMemberPatch(body, { requireCli: true });
      if (!patch.cli?.command) throw new Bad(400, "cli.command 不能为空");
      if (!patch.name) patch.name = key;

      raw[key] = patch;
      writeUserConfig(raw);
      if (!reloadConfig()) throw new Bad(500, "配置写入后校验失败，请检查命令行配置");
      log(`👥 已添加群成员: ${key}`);
      res.json({ ok: true, member: memberView(key) });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // 更新成员：模型、启用状态、名称、角色、显式 CLI 覆盖等
  app.put("/api/members/:key", (req, res) => {
    try {
      const key = req.params.key;
      if (!KEY_RE.test(key)) throw new Bad(400, "key 非法");
      const spec = AGENT_CATALOG[key] || AGENTS[key];
      if (!spec) throw new Bad(404, "成员不存在");

      const raw = getUserConfigRaw();
      const patch = buildMemberPatch(req.body || {}, { requireCli: false });

      // 浅合并到现有覆盖层（不整体替换，保留 cli 等未编辑字段）
      const prev = raw[key] && typeof raw[key] === "object" ? raw[key] : {};
      raw[key] = {
        ...prev,
        ...patch,
        // cli 单独浅合并，避免编辑 model 时把 cli 覆盖掉
        ...(patch.cli ? { cli: { ...(prev.cli || {}), ...patch.cli } } : {}),
      };
      writeUserConfig(raw);
      if (!reloadConfig()) throw new Bad(500, "配置写入后校验失败，请检查命令行配置");
      res.json({ ok: true, member: memberView(key) });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  // 停用/移除成员：内置成员写 enabled:false；自定义成员从配置中删除
  app.delete("/api/members/:key", (req, res) => {
    try {
      const key = req.params.key;
      if (!KEY_RE.test(key)) throw new Bad(400, "key 非法");
      const builtin = !!AGENT_CATALOG[key];
      const raw = getUserConfigRaw();
      if (!builtin && !raw[key]) throw new Bad(404, "成员不存在");

      if (builtin) {
        const current = raw[key] && typeof raw[key] === "object" ? raw[key] : (AGENT_CATALOG[key] || {});
        raw[key] = { ...current, enabled: false };
      } else {
        delete raw[key];
      }
      writeUserConfig(raw);
      reloadConfig();
      log(`👥 已移除群成员: ${key}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });
}