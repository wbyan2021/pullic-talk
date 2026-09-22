# S06 · 网页 Key 管理安全加固设计

- 状态：`accepted`（2026-09-23 用户批准设计稿，并要求当晚完成实现与自动化验证，真实验收随后由用户执行）
- 日期：2026-08-28（2026-09-23 批准）
- 切片：S06-web-key-management（candidate → 本设计批准后 Ready）
- 基线：`main` @ `a19f146`（S05 已合并）
- 风险等级：high（涉及凭据）

## 1. 一句话目标

用户可以在网页「🔑 Key」面板安全管理群聊成员/自定义 CLI 的本机 Key：浏览器永不接收明文值，服务重启后自动加载，且不改变 DeepSeek 护航 Key 只走 S01 macOS Keychain 的事实。

## 2. 背景（当前实现的真实行为）

- `GET /api/secrets` 返回 `~/.secrets.env` 全部条目的**明文值**（运行时环境值优先，其次文件字面值）。
- `POST /api/secrets` 合并写入（空值 = 删除），响应再次返回**明文快照**。
- 前端 `public/js/secrets.js` 把明文填进输入框，并提供「显示」按钮切换明文可见。
- 服务启动时**不**读取 `~/.secrets.env`；只有网页保存后才同步当前进程环境。保存提示文案与重启行为不一致。
- 以上即 PRODUCT.md 9.2 风险 #7/#8。

## 3. 已确认的设计决策（2026-08-28 用户逐项确认）

| 决策 | 结论 |
|---|---|
| D1 浏览器暴露 | 服务端不再向浏览器返回明文值；页面只显示统一掩码 |
| D2 重启加载 | 服务启动时自动加载 `~/.secrets.env`；不覆盖启动命令已显式设置的同名变量 |
| D3 使用边界 | 仅用于群聊成员/自定义 CLI 的本机 Key；DeepSeek 护航 Key 仍只走 S01 Keychain，本面板不是其等价替代 |
| D4 验收方式 | 用户决策委托给 AI：假 Key 全流程验收 + 浏览器响应/磁盘文件/日志/Git 状态四处无明文核对（详见 §7） |

## 4. 目标行为

### 4.1 掩码快照（D1）

- `secrets-env.js` 新增 `maskValue()`：所有非空值统一返回 `"••••••••"`（8 个圆点，不泄露任何字符与长度）。
- `GET /api/secrets` 响应：`{ ok, path, vars: { KEY: "••••••••" } }`——键名可见，值一律掩码。
- `POST /api/secrets` 响应同样只含掩码快照。

### 4.2 编辑语义（D1 的连带变化）

- 页面不再回显旧值：已有条目的值输入框为空，占位符「留空 = 保持不变」。
- POST 只提交用户实际改动的键：
  - 输入了新值 → `KEY: "new value"`（覆盖写入，沿用现有 merge 写文件语义）；
  - 移除了已有行 → `KEY: ""`（沿用现有删除语义）；
  - 空值且未移除 → 不提交该键（服务端保持原值）。
- 服务端校验不变：≤60 键、值 ≤2000 字符、`KEY_RE` 变量名规则、trim。
- 移除「显示/隐藏」按钮：服务端已无明文可显示；输入过程中用户所见即所输（type=password）。

### 4.3 启动自动加载（D2）

- `secrets-env.js` 新增 `loadSecretsIntoProcess()`：读取 `SECRETS_ENV_PATH` 文件的 `export KEY='value'` 行；
  - `process.env[KEY]` 已存在且非空 → **不覆盖**（启动命令显式设置的变量优先）；
  - 文件字面值为空或 `${VAR:-…}` 回退写法 → 跳过；
  - 加载结果写一行启动日志（只报数量，不报值）。
- `src/server.js` 启动装配处调用一次；同步后派生的群聊 CLI 子进程继承这些变量（现有行为）。

### 4.4 使用边界与文案（D3）

- 面板描述改为：「仅管理群聊成员 / 自定义 CLI 的本机 Key；DeepSeek 护航 Key 存于 macOS 钥匙串，不在此处。」
- 保存成功提示改为：「已保存并立即生效；重启服务后会自动加载（不覆盖启动时已设置的同名变量）。」
- PRODUCT.md 7.3 数据表、9.1/9.2 风险条目在实现完成后同步改写（重启加载成为事实后才能写成承诺）。

## 5. 明确不做

- 不做 Keychain 同步、加密存储或浏览器端加密。
- 不做按角色的权限分级（仍是本机单用户 + Token 闸门）。
- 不把 `~/.secrets.env` 用于 Pi 认证（Pi 走 `PI_AUTH_PROVIDER` 链路）。
- 不改 DeepSeek 护航凭据链路（S01）。

## 6. 修改范围

| 文件 | 变化 |
|---|---|
| `src/utils/secrets-env.js` | 新增 `maskValue`、`loadSecretsIntoProcess` |
| `src/routes/secrets.js` | GET/POST 响应改掩码快照；注释与「留空=保持」契约说明 |
| `src/server.js` | 启动时调用 `loadSecretsIntoProcess()`（一行装配） |
| `public/js/secrets.js` | 掩码渲染、覆盖编辑流、移除 reveal、文案 |
| `public/chat.html` / `public/css/secrets.css` | 面板描述文案、必要的样式微调 |
| 测试 | `secrets-env.test.js`（掩码/加载/不覆盖）、`secrets-routes.test.js`（响应无明文断言）、UI 静态断言（无 reveal、无明文回显） |
| 文档 | `docs/NOW.md`、`docs/PRODUCT.md`、`docs/CODEMAP.md`、README 相关句 |

不修改：护航/凭据存储（S01）、群聊调用链、Pi 执行链路、项目/执行/恢复/总览模块。

## 7. 验证与验收（D4）

### 自动化（AI 责任）

1. `maskValue` 单元测试：任意非空值输出统一掩码；空值不进入快照。
2. `loadSecretsIntoProcess` 测试（注入临时文件路径）：加载缺失键、不覆盖已存在键、跳过空值/回退行。
3. 路由测试：GET/POST 响应断言不包含真实值（用假值 `S06_FAKE_VALUE_ABC123` 注入后，响应体不含该子串）；POST 覆盖/删除/保持不变三语义。
4. UI 静态断言：不存在 reveal 按钮；已有条目值输入框为空且带「留空 = 保持不变」占位。
5. 全量 `npm test`、逐文件 `node --check`、`git diff --check`、strict 结构校验、隔离端口健康检查。

### 真实验收（用户，假 Key 全流程）

- 在面板添加 `S06_FAKE_KEY` = 假值 → 保存后页面只见掩码；`~/.secrets.env` 中为 shell 单引号形式。
- 重启服务 → 面板仍显示该键（掩码），群聊 CLI 能取到该环境变量。
- 覆盖编辑一次、删除一次；未改动的键保持原值。
- 核对：浏览器响应、磁盘文件、服务日志、`git status` 四处无明文假值出现在不该出现的位置（文件内出现是预期并已脱敏核对格式）。
- 确认 DeepSeek 护航连接检测不受影响（护航 Key 仍走 Keychain）。

## 8. 回滚策略

全部变化限于上表文件；如验收失败，回退工作分支即可，`~/.secrets.env` 属用户本机数据，代码不删除该文件。
