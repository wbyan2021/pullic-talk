# S06 · 网页 Key 管理安全加固实现计划

- 状态：`active`（2026-09-23 随设计稿批准生效）
- 日期：2026-08-28（2026-09-23 生效）
- 设计稿：[2026-08-28-s06-web-key-management-design.md](../superpowers/specs/2026-08-28-s06-web-key-management-design.md)
- 架构决定：[ADR-004](../decisions/ADR-004-masked-web-key-management.md)
- 工作分支（待创建）：`codex/v0.1-s06-web-key-management`，自 `main` 基线创建
- 风险等级：high

## 任务列表（测试先行）

### Task 1 · secrets-env 掩码与启动加载（测试先行）

- `test/secrets-env.test.js` 新增：
  - `maskValue` 对任意非空值返回统一 `••••••••`；
  - `loadSecretsIntoProcess(path)`：注入临时文件 → 加载缺失键；已存在的 `process.env` 键不被覆盖；空值行与 `${VAR:-…}` 回退行跳过。
- `src/utils/secrets-env.js`：实现 `maskValue`、`loadSecretsIntoProcess`（复用 `readSecretsFile`/`prettyValue`）。

### Task 2 · 路由掩码契约（测试先行）

- `test/secrets-routes.test.js` 调整/新增：
  - GET 响应 `vars` 值全部为掩码；注入假值后响应体不含假值子串；
  - POST 覆盖写入后响应同样掩码；
  - 「保持不变」语义：POST 不含某键 → 该键原值保留；
  - 删除语义保留（空值 = 删除）。
- `src/routes/secrets.js`：GET/POST 响应改用掩码快照；更新注释描述留空语义。

### Task 3 · 服务启动装配

- `src/server.js`：启动时调用 `loadSecretsIntoProcess()`，日志只报数量不报值。
- 测试：复用 Task 1 服务层测试；装配以既有隔离端口健康检查兜底。

### Task 4 · 前端掩码编辑流与文案

- `public/js/secrets.js`：
  - 渲染只填键名，值输入框留空 + 占位「留空 = 保持不变」；
  - `collect()` 只提交：新值非空的键、被移除的已有键（空值删除）；
  - 移除 reveal 按钮及逻辑；
  - 保存成功提示按设计稿 §4.4 更新。
- `public/chat.html`：面板描述文案（D3 边界）。
- `public/css/secrets.css`：必要的样式微调（占位/布局）。
- UI 静态断言：无 reveal；已有条目值输入框初始为空；文案含「macOS 钥匙串」边界说明。

### Task 5 · 文档对齐

- `docs/PRODUCT.md`：5.3 本地 Key 管理、7.3 数据表、9.1 已有措施、9.2 风险 #7/#8 按 D1–D3 事实改写；
- `docs/CODEMAP.md`：`/api/secrets` 路由职责描述更新；
- README 相关句子核对（自动加载成为事实后允许写入）。

### Task 6 · 全量验证 + 用户真实验收

- 全量 `npm test`；逐文件 `node --check`；`git diff --check`；strict 结构校验；隔离端口 `43211` 健康检查（带 `PI_AUTH_PROVIDER=aliyun-token-plan`）。
- 用户按设计稿 §7 假 Key 全流程验收；通过后 S06 标 done，fast-forward 合并入 `main` 并删除工作分支。

## 验证命令

```bash
npm test
git ls-files '*.js' | xargs -n1 node --check
git diff --check
node ~/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs . --strict
PI_AUTH_PROVIDER=aliyun-token-plan PORT=43211 npm start   # 隔离端口健康检查
```

## 安全红线（实现期间）

- 测试只使用假 Key/临时目录；不读取、不输出真实 `~/.secrets.env` 内容。
- 服务日志与测试输出不得包含任何真实或假的完整 Key 值（掩码断言兜底）。
- 不触碰 S01 Keychain 链路、Pi 认证链路、群聊调用主链路。
