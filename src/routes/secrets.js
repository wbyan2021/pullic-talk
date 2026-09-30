import { getMaskedSnapshot, writeSecretsFile, registerManagedSecretNames, SECRETS_ENV_PATH, KEY_RE, MASKED_VALUE } from "../utils/secrets-env.js";

// 网页端管理 ~/.secrets.env（S06/D1：浏览器永不接收明文值）：
// GET /api/secrets   -> 掩码快照：键名可见，值一律 ••••••••
// POST /api/secrets  -> 覆盖式写入：只提交用户实际改动的键；
//                       非空值 = 覆盖，空字符串 = 删除，未提交的键保持原值
export default function secretsRoutes(app) {
  app.get("/api/secrets", (req, res) => {
    res.json({
      ok: true,
      path: SECRETS_ENV_PATH,
      vars: getMaskedSnapshot(),
    });
  });

  app.post("/api/secrets", (req, res) => {
    const body = req.body || {};
    const vars = body.vars;

    if (vars === undefined || vars === null || typeof vars !== "object" || Array.isArray(vars)) {
      return res.status(400).json({ error: "vars 必须是对象" });
    }
    const entries = Object.entries(vars);
    if (entries.length > 60) return res.status(400).json({ error: "key 数量过多（>60）" });

    const clean = {};
    for (const [k, v] of entries) {
      if (!KEY_RE.test(k)) {
        return res.status(400).json({ error: `非法变量名: ${k}` });
      }
      if (v === undefined || v === null) {
        return res.status(400).json({ error: `${k} 的值不能为空` });
      }
      if (typeof v !== "string" || v.length > 2000) {
        return res.status(400).json({ error: `${k} 的值必须是 ≤2000 的字符串` });
      }
      // key/token 不应带首尾空白；粘贴时带来的首尾换行在这里就消掉，不算错误
      const trimmed = v.trim();
      if (trimmed === MASKED_VALUE) {
        // 掩码值不是真实凭据：拒绝回传掩码，防止把真值覆盖成 "••••••••"
        return res.status(400).json({ error: `${k} 的值是掩码占位符，请输入真实值（留空 = 保持不变）` });
      }
      if (/[\r\n\u0000]/.test(trimmed)) {
        // 文件是“一行一个 export KEY=值”的格式：值里带内部换行会让写入后的续行脱离
        // 解析（该键既不进快照也不被启动加载），删除它还会留下悬空引号破坏 source
        return res.status(400).json({ error: `${k} 的值不能包含内部换行（每个 Key 必须是单行值）` });
      }
      clean[k] = trimmed;
    }

    try {
      writeSecretsFile(clean);
    } catch (e) {
      return res.status(500).json({ error: `写入失败：${e.message}` });
    }

    // 同步当前服务进程的环境变量：空值删除，非空立即生效（之后派生的 CLI 会带上新值）
    for (const [k, v] of Object.entries(clean)) {
      if (v === "") delete process.env[k];
      else process.env[k] = v;
    }
    // 这些键从此属于"网页 Keyring"：进入他人代码的子进程（项目内的 Pi 任务、
    // 验收命令）会把它们剥掉，网页面板存的整机凭据不该跟着走进克隆来的仓库
    registerManagedSecretNames(Object.keys(clean));

    res.json({ ok: true, path: SECRETS_ENV_PATH, vars: getMaskedSnapshot() });
  });
}