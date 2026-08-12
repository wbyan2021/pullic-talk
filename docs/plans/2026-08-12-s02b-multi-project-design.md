# S02b · 多项目并行管理 · 设计稿

> 状态：`accepted`（2026-08-12 用户批准）
> 日期：2026-08-12
> 前置：S01、S02 已 done 并合并入 main；基线 `e01ba95`
> 分支：`codex/v0.1-s02b-multi-project`（批准后从 `main` 当前 HEAD 创建）

## 1. 背景与目标

S02 按 v0.1 原基线实现为**单项目**：`projects.local.json` 只有 `project` 一个记录，`select()` 覆盖式写入。用户实际使用场景是同时管理多个 Git 项目（如账目管理、声音世界、文博知识库等），因此把「多项目并行管理」纳入 v0.1 范围（用户已确认，PRODUCT.md/NOW.md 已更新）。

目标一句话：**项目 view 可同时录入多个 Git 项目，列表查看各自状态，逐项刷新/移除，并指定一个「活动项目」供后续 S03 的 Pi 受控运行使用。**

## 2. 现状（事实）

- `src/services/project-boundary.js`：内存 `record`（单对象），持久化 `{ version: 1, project }`，API `getStatus/select/refresh/clear`。
- `src/routes/project.js`：`GET /api/project/status`、`POST /select`（body.path）、`POST /refresh`、`POST /clear`；响应 `{ ok, project }`；错误映射表 + 字段白名单。
- `public/js/project.js`：单个卡片渲染（`renderSelected`），选择表单，确认移除。
- 用户真实数据：`projects.local.json` v1，含「个人资产管理」项目（含 selectionSnapshot 与 lastInspection）。**迁移必须保留该数据。**

## 3. 数据模型（v2）

```jsonc
{
  "version": 2,
  "activeProjectId": "<hash12>",          // 可能为空（无活动项目）
  "projects": {
    "<hash12>": {                          // id = sha1(repoRoot) 前 12 位
      "id": "<hash12>",
      "inputPath": "...",
      "resolvedPath": "...",
      "repoRoot": "...",
      "selectedAt": "ISO",
      "selectionSnapshot": { ... },        // 同 v1 结构
      "lastInspection": { ... }            // 同 v1 结构
    }
  }
}
```

规则：

- **id 稳定**：由 `repoRoot` 哈希生成，同一目录重复录入幂等（更新该条目而非新增）。
- **活动项目**：`activeProjectId` 指向当前用于 S03 的项目；可为空。
- **迁移（v1→v2）**：加载时若读到 `version === 1 && project`，生成 `projects[hash] = project`，`activeProjectId = hash`，随后持久化为 v2；不丢任何字段。
- **失效判定**：沿用现有 `isExistingDir(repoRoot)`，按项目逐项计算 `stale`。

## 4. 服务层 API（project-boundary.js）

| 方法 | 语义 |
|---|---|
| `getStatus()` | 返回 `{ projects: [payload...], activeProjectId, active: payload\|null }`；projects 按 `selectedAt` 升序（先录入在前） |
| `select(inputPath)` | 录入/更新项目（幂等）；**不改变活动项目**；返回该项目 payload |
| `setActive(id)` | 设置活动项目；id 不存在抛 `project_not_found` |
| `refresh(id)` | 刷新指定项目；id 缺失时刷新活动项目（兼容旧调用）；无活动且无 id 抛 `no_project_selected` |
| `clear(id)` | 移除指定项目；id 缺失时移除活动项目；若移除的是活动项目，`activeProjectId` 置空 |

错误码新增：`project_not_found`（指定的项目 id 不存在）。

## 5. 路由契约（project.js）

- `GET /api/project/status` → `{ ok: true, projects: [safeProject...], activeProjectId }`
- `POST /api/project/select` → body `{ path }` → `{ ok: true, project: safeProject }`（单个）
- `POST /api/project/activate` → body `{ id }` → `{ ok: true, activeProjectId }`（新增）
- `POST /api/project/refresh` → body `{ id? }` → `{ ok: true, project: safeProject }`
- `POST /api/project/clear` → body `{ id? }` → `{ ok: true }`（清空后 projects 列表返回可再查 status）

`safeProject` 白名单增加 `id` 字段；所有响应保持 `{ ok, code, message, action, retryable }` 错误形状。

## 6. 前端 UI（project.js / project.css）

项目 view 结构：

```
[添加项目表单（保持现有）]
─────────────────────────
[项目列表]
  [项目卡片 1]  ← 活动项目带徽标「ACTIVE」
  [项目卡片 2]  ← 失效时显示错误卡
  ...
[空状态]：未录入任何项目
```

卡片内容与操作：

- 标题：repoRoot 目录名 + 完整路径（现有样式复用）；
- 状态行：分支、最近提交（hash/date/subject）、改动计数（staged/unstaged/untracked/conflicted）；
- 操作按钮：**设为活动**（非活动项目）、刷新、移除（双击确认，沿用现有确认流）；
- 活动项目显示「ACTIVE」徽标，且「设为活动」按钮隐藏/禁用；
- 全部用 `textContent` 渲染，无 innerHTML（延续 S02 UI 回归约束）。

## 7. S03 联动（说明，不在本切片实现）

- S03 的 cwd 取「活动项目」repoRoot：`activeProjectId` 缺失时对应错误提示改为「先设置活动项目」；
- S03 设计稿 §9 的禁改路径中不再把 `project-boundary.js` 列为禁改（S02b 后其 API 已含 active 语义），其余禁改不变。

## 8. 修改范围

**允许：**
- `src/services/project-boundary.js`（v2 数据模型 + active + 迁移）
- `src/routes/project.js`（契约扩展）
- `public/js/project.js`、`public/css/project.css`（列表 UI）
- `test/project-boundary.test.js`、`test/project-routes.test.js`、`test/project-ui.test.js`（含迁移夹具）
- `docs/`（本设计稿、NOW.md、PRODUCT.md 已部分更新）
- `src/server.js`：仅当装配需要（预期不需要，`createProjectBoundary` 签名不变）

**禁止：**
- `src/services/git-inspector.js`（只读识别逻辑）
- 护航（`src/providers/*`、`src/services/escort-service.js`、`src/routes/escort.js`、`public/js/escort.js`、`public/css/escort.css`、`public/index.html` 的护航部分）
- 群聊、终端、安装、`public/vendor/`、`tools.json`、`.token`、`agents.config.json`

## 9. 测试计划

| 测试 | 覆盖 |
|---|---|
| 迁移 | v1 夹具（真实旧格式含 selectionSnapshot/lastInspection）→ v2，字段无损；损坏文件降级空状态 |
| 多项目增删 | 录入 2+ 项目；同 repoRoot 幂等；`clear` 单项不影响他项 |
| 活动项目 | `setActive` 成功/未知 id 报错；清除活动项目后 `activeProjectId` 置空 |
| 路由契约 | 新 API 形状与字段白名单；错误码映射（含 `project_not_found`） |
| UI | 列表渲染、ACTIVE 徽标、无 innerHTML 静态回归、确认流保留 |
| 全量回归 | `npm test` 全绿（既有 110 + 新增） |

## 10. 验证命令

```bash
node --test test/project-boundary.test.js test/project-routes.test.js test/project-ui.test.js
npm test                       # 全量
git ls-files '*.js' | xargs -n1 node --check
PORT=43215 npm start           # 隔离端口健康检查 /api/health
```

## 11. 风险与缓解

- **迁移丢数据**：迁移测试用真实 v1 格式夹具；实施时先备份 `projects.local.json` 到 `.bak`（提交前不覆盖），人工验收时核对「个人资产管理」仍在。
- **只读回归**：git-inspector 禁改；全量测试 + 验收前后 `git status --porcelain` 对比。
- **UI 布局回归**：沿用 S02 的桌面/窄屏验证方式。
- 风险等级：**中**（本地持久化变更，无凭据/付费服务）。

## 12. Definition of Ready 检查

见 NOW.md S02b 段落；待办：用户批准（`draft → accepted`）→ 产出实现计划（TDD 任务拆分）。
