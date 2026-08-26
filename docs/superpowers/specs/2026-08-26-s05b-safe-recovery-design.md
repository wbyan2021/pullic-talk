---
type: slice-design
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S05-B-safe-recovery
design_status: accepted
ready_status: pending
risk_level: high
created: 2026-08-26
updated: 2026-08-26
---

# S05-B「安全恢复」设计稿

## 1. 设计结论

第一版恢复采用“重启式恢复”：只为 `failed`（失败）和 `interrupted`（中断）任务提供恢复入口。恢复不会续接旧 Pi 进程，不执行 Git 回退，不覆盖旧黑匣子记录，而是在用户确认后创建一个新的 Pi 执行批次，并在新旧记录之间建立来源关联。

总览页仍然是只读汇总面。它可以在“证据与验收”卡片中显示“可恢复 / Recoverable”和“去项目页恢复 / Open Project to Recover”，但真正的预览和确认动作由项目执行面板与恢复服务负责。

用户主动 `stopped`（已停止）的任务、已验收 `accepted` 的任务和执行成功的任务不提供恢复入口。第一版不处理项目文件回退；任何文件回退都必须另建高风险切片。

## 2. 用户起点、终点与范围

### 起点

Pi 任务因为认证失败、进程异常、服务重启或其他非用户主动停止原因进入 `failed` 或 `interrupted`。用户进入总览或项目页查看任务证据。

### 终点

用户能够看到任务是否可恢复，阅读恢复前预览并明确确认；系统在同一个活动 Git 项目内启动新的 Pi 批次，保留原任务记录、记录恢复来源，并让新批次继续走现有任务证据、验收和 AI 交接闭环。

### 本切片目标

- 识别可恢复的失败/中断任务；
- 生成一次性的恢复预览；
- 在二次确认和状态复核后重启 Pi；
- 将恢复来源、结果和错误写入黑匣子；
- 让总览和项目执行面板展示一致的恢复状态；
- 对所有不满足条件的情况给出明确、脱敏的原因。

### 非目标

- 不恢复用户主动停止的任务；
- 不续接旧 Pi 会话或旧进程；
- 不修改、删除、覆盖或回退项目文件；
- 不执行 `git reset`、`git restore`、自动提交、合并或推送；
- 不实现多任务并行、远程恢复或跨项目迁移；
- 不把原始任务文本、终端输出、stderr、命令参数或密钥返回浏览器。

## 3. 用户流程与状态机

### 3.1 页面流程

1. 总览的证据卡显示 `可恢复 / Recoverable`，并标出来源任务的安全 ID 和状态；
2. 用户点击“去项目页恢复 / Open Project to Recover”；
3. 项目执行面板请求恢复预览；
4. 预览显示来源状态、失败原因、当前项目/分支/HEAD、改动数量和“不会回退文件”的明确说明；
5. 用户点击“确认恢复 / Confirm Recovery”；
6. 服务再次检查预览指纹、活动项目和执行锁；
7. 通过检查后创建新的 Pi 批次，页面回到普通执行观察状态；
8. 新任务完成、失败或中断时，复用现有验收和 AI 交接流程。

取消预览不启动任何进程，也不改变项目文件。预览过期、项目变化或已有运行任务时，确认动作被拒绝并要求重新加载。

### 3.2 状态

```text
not_eligible → previewable → previewed → confirmed → starting → running → terminal
                                  └──── cancelled
previewed / confirmed → stale（预览指纹失效）
confirmed → rejected（复核失败）
starting → start_failed
```

只有来源执行状态为 `failed` 或 `interrupted` 且未被验收为 `accepted` 时，才能进入 `previewable`。来源状态为 `stopped`、`exited`、`accepted` 或缺少完整记录时保持 `not_eligible`。

## 4. 架构与事实源

### 4.1 唯一事实所有权

- `blackbox-store`：来源任务事件、新恢复事件和新任务的恢复关联；历史内容只追加、不覆盖；
- `task-evidence`：新 Pi 批次的开始、停止、Git 前后快照、验证和验收；
- `project-boundary`：活动项目、项目 ID、失效状态和项目边界；
- `pi-executor`：实际 Pi 进程启动、状态和终止；
- `ai-handoff`：当前交接文件和唯一下一步；恢复不直接伪造交接状态；
- `overview`：只读投影恢复摘要，不保存恢复状态副本；
- `recovery service`：恢复资格、预览指纹、确认和跨服务编排，不成为第二个任务事实源。

### 4.2 新增恢复服务

新增 `src/services/task-recovery.js`，只接受 `projectBoundary`、`blackboxStore`、`taskEvidence`、`aiHandoff` 和时钟/随机数依赖。它负责：

- 读取来源任务的已脱敏黑匣子事件；
- 计算资格和安全原因码；
- 生成短时有效的预览句柄与状态指纹；
- 确认时重新读取项目和任务状态；
- 将恢复来源传递给新的 `taskEvidence.start`；
- 记录恢复事件和稳定错误码。

恢复服务不读取项目目录中的任意文件，不把原始任务文本或事件数组交给前端。原任务文本只在服务端、从已脱敏的 `task_created` 事件取出，用于启动新的 Pi 批次。

### 4.3 接口边界

新增认证路由 `src/routes/recovery.js`：

- `GET /api/recovery/status`：返回当前活动项目的安全恢复摘要；
- `GET /api/recovery/:taskId/preview`：只读生成预览句柄；
- `POST /api/recovery/:taskId/start`：必须携带预览句柄和 `confirmed: true`，成功后启动新的 Pi 批次。

`src/routes/overview.js` 增加只读 `overview.evidence.recovery` 投影。`public/js/overview.js` 只显示摘要和跳转，不调用恢复写入接口。项目执行面板增加预览、确认、取消和错误状态，但不复制任务证据事实。

## 5. 数据契约

### 5.1 总览摘要

```text
overview.evidence.recovery
  available: boolean
  sourceTaskId: string | null
  sourceState: "failed" | "interrupted" | null
  reasonCode: string | null
  state: "not_available" | "previewable" | "busy" | "stale" | "unknown"
```

此投影不包含原始任务文本、输出、stderr、cwd、args、完整路径数组或预览句柄。

### 5.2 恢复预览

```text
{
  ok: true,
  recovery: {
    eligible: true,
    sourceTaskId,
    sourceState,
    reasonCode,
    projectId,
    branch,
    head,
    worktree,
    changedCount,
    beforeHead,
    previewId,
    expiresAt,
    confirmationRequired: true,
    fileRollback: "not_included"
  }
}
```

`previewId` 是短时、一次性、服务端可验证的句柄；它不是任务文本，也不是凭据。预览响应不返回完整变更路径和原始错误文本。

### 5.3 新任务关联

新的 `task_created` 和 `recovery_started` 事件只保存：

- `sourceTaskId`；
- 新任务 ID 和新的 Pi run ID；
- 来源状态和稳定原因码；
- 预览/确认时间；
- 项目 ID；
- 安全的状态与退出码。

恢复事件写入黑匣子时沿用现有统一脱敏、长度上限和追加语义。旧任务的历史内容不覆盖；如需关联审计，只能追加受控事件。

## 6. 预览复核与失败处理

预览创建时保存以下复核事实：来源任务 ID、来源项目 ID、来源终态事件序号、当前活动项目 ID、分支、HEAD 和工作区改动计数。确认时必须重新读取并逐项比较。

稳定错误码和用户提示：

| 错误码 | 页面提示 | 处理建议 |
|---|---|---|
| `recovery_not_eligible` | 此任务当前不可恢复。 | 查看任务状态和验收结果 |
| `recovery_task_not_found` | 找不到原任务记录。 | 刷新总览 |
| `recovery_payload_unavailable` | 原任务记录不完整，无法安全恢复。 | 重新开始一条新任务 |
| `recovery_project_stale` | 活动项目已失效。 | 重新识别或选择项目 |
| `recovery_busy` | 已有 Pi 任务正在运行。 | 等待当前任务结束 |
| `recovery_preview_expired` | 恢复预览已过期或项目状态已变化。 | 重新生成预览 |
| `recovery_confirmation_required` | 需要明确确认后才能恢复。 | 阅读预览并确认 |
| `recovery_start_failed` | 恢复启动失败，原任务记录已保留。 | 根据错误码处理后重试 |
| `recovery_internal_error` | 恢复服务暂时不可用。 | 重新加载页面 |

任何未知异常都映射为 `recovery_internal_error`，不透传内部错误、命令输出或路径。

## 7. 安全与威胁分析

- **错误项目重放**：来源项目 ID 必须等于当前活动项目 ID；不接受浏览器提交的项目路径覆盖。
- **预览后状态变化**：确认时重新检查指纹；分支、HEAD、改动计数或来源终态变化即拒绝。
- **重复点击/并发**：预览句柄一次性消费；复用现有单 Pi 执行锁；已有运行任务直接返回 `recovery_busy`。
- **秘密泄露**：只在服务端使用已脱敏任务文本；所有响应字段白名单；不返回任务原文、输出、stderr、args、cwd、Key、Token 或私钥。
- **破坏性动作**：恢复只调用现有 Pi 启动链路，不执行 Git 写命令，不写项目业务文件；黑匣子和交接记录写入沿用原子/追加保护。
- **服务重启**：短时预览句柄在服务重启后失效；来源任务仍保留，可重新生成预览。

## 8. 测试与验收映射

### 自动化测试

- `test/task-recovery.test.js`：资格判断、失败/中断、停止/成功/已验收拒绝、来源项目校验、指纹失效、句柄一次性、旧记录保留、新任务来源关联。
- `test/recovery-routes.test.js`：路由注册、认证、预览/确认参数、稳定错误码、字段白名单和敏感字段排除。
- `test/overview-routes.test.js`：可恢复摘要投影、不可恢复空状态、无任务运行时的安全状态。
- `test/overview-ui.test.js` 与项目执行 UI 测试：恢复摘要双语显示、跳转到项目页、预览确认交互、取消和失败状态。
- 集成测试：构造失败和服务重启中断任务，生成预览并启动新的 Pi 批次；确认不调用 Git 回退、不覆盖来源记录。

### 用户验收

1. 制造一条失败任务，确认总览出现“可恢复”；
2. 制造一条服务重启导致的中断任务，确认也可恢复；
3. 打开预览，确认只看到状态、原因、项目和改动数量；
4. 确认预览明确写出“不回退文件”；
5. 确认恢复后生成新的任务 ID，并显示恢复来源；
6. 确认来源任务历史仍可读取；
7. 对用户主动停止、已验收任务、项目失效和已有运行任务，确认恢复入口被禁止并显示原因；
8. 确认页面和记录中不出现 Key、Token、原始输出、stderr、命令参数或完整路径列表。

## 9. Definition of Ready

- [x] 用户确认第一版只恢复失败/中断，不恢复主动停止。
- [x] 用户确认采用重启式恢复，不续接旧进程、不回退文件。
- [x] 用户确认页面预览、二次确认和失败提示流程。
- [x] 架构决定、事实源、接口边界和敏感字段规则已写明。
- [x] 失败路径、并发、状态变化和服务重启风险已列出。
- [ ] 实现计划已完成并通过用户审阅。
- [ ] 安全测试、代码审查和候选提交上的新鲜验证已安排。

## 10. 后续切片

项目文件回退、检查点选择、恢复历史搜索、Pi 会话续接和多任务并行均不属于 S05-B。它们必须在新的高风险设计中分别确认，不得因为本切片的恢复按钮而隐式加入。
