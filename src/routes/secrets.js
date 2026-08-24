import { getSecretsSnapshot, writeSecretsFile, SECRETS_ENV_PATH, KEY_RE } from "../utils/secrets-env.js";

// 网页端管理 ~/.secrets.env：
// GET /api/secrets   -> 快照（运行时值优先）
// POST /api/secrets  -> 合并写入；value 为空字符串表示删除该 key
export default function secretsRoutes(app) {
  app.get("/api/secrets", (req, res) => {
    res.json({
      ok: true,
      path: SECRETS_ENV_PATH,
      vars: getSecretsSnapshot(),
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
      clean[k] = v.trim(); // key/token 不应包含首尾空白
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

    res.json({ ok: true, path: SECRETS_ENV_PATH, vars: getSecretsSnapshot() });
  });
}