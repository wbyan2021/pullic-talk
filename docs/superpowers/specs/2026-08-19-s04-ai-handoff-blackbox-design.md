---
type: slice-design
project: AI·OPS COCKPIT
workflow_version: 4
milestone: v0.1-first-controlled-mission
slice: S04-evidence-and-blackbox
design_status: accepted
ready_status: pending
risk_level: high
created: 2026-08-19
updated: 2026-08-19
---

# S04「证据与黑匣子」设计稿

## 1. 设计结论

S04 的第一读取者是下一次接手项目的 Codex、Pi 等开发 AI。护航 AI 只负责产品使用说明、操作引导和故障解释，不作为开发任务事实源。

S04 采用“本地事实账本 + 项目内 AI 交接投影”的混合结构：

1. 产品本地黑匣子保存任务执行事件和安全诊断数据，不进入目标项目 Git。
2. 目标项目内生成脱敏、稳定、可被开发 AI 读取的当前交接和历史记录。
3. 项目记录不自动提交 Git；用户或开发 AI 决定是否提交。
4. 系统观察、用户确认和 Agent 自述严格分层，不能互相冒充。

本切片不改变 S03 的 Pi 语义：仍是单实例、单项目、一次性 `-p task_text --no-session --mode json` 执行，不实现会话续传。

## 2. 用户问题与目标

用户每次完成开发任务后，希望下一次 Codex/Pi 能快速知道：

- 做了什么文档、代码和维护工作；
- 哪些内容来自真实系统证据；
- 项目整体规划完成了多少；
- 测试和验收是否真实执行；
- 当前存在什么问题和风险；
- 下一次唯一应该做什么。

S04 的目标是让一次任务无论成功、失败、停止或异常中断，都留下可恢复的机器优先记录。

## 3. 范围

### 3.1 包含

- 任务开始和结束的 Git/项目快照；
- Pi 运行事件的本地追加记录；
- 文件变化和既有改动的分类摘要；
- 用户确认的验收命令及真实退出结果；
- 脱敏的 AI 交接当前文件和历史文件；
- 失败、停止和中断任务的恢复记录；
- 规划来源、版本和进度快照；
- 开发 AI 的固定读取顺序和行为约束。

### 3.2 不包含

- Pi 会话续传或多任务并发；
- 自动提交、合并、推送或回滚 Git；
- 完整原始终端日志或完整 Pi transcript 的持久化；
- 通用语言/框架的自动测试发现和自动判断；
- 根据代码行数、输出长度或 AI 判断推算进度；
- 将护航 AI 作为开发任务事实源；
- 改写现有 Node/Express/WebSocket/SSE/node-pty 技术栈。

## 4. 数据边界与所有权

### 4.1 产品本地黑匣子

黑匣子位于产品现有本地状态根目录下的 `blackbox.local/`，必须纳入 Git 忽略边界。它属于本机运行数据，不属于目标项目源代码。

按项目和任务分目录保存（示例标识使用固定的机器可读字段名）：

```text
blackbox.local/project_id/task_id.jsonl
```

每一行是一个有序事件。服务重启后可从最后完整行恢复；未出现闭合事件的任务标记为 `interrupted`。

黑匣子保存经过脱敏和上限处理的安全载荷。原始 stdout/stderr 只在内存中短暂存在，不在脱敏前落盘。

### 4.2 项目内 AI 交接资产

用户为项目启用交接记录后，产品创建或更新：

```text
docs/ai-ops/NOW.md
docs/ai-ops/records/task_id.md
```

已有 `AGENTS.md` 时，只在用户授权后增加带边界标记的入口；不得覆盖已有指令。没有 `AGENTS.md` 时，创建最小入口也需要用户授权。

项目内记录可以进入 Git，但产品不自动提交。交接文件自身的变化必须在证据中单独归类，不能被算作产品功能已经完成。

### 4.3 规划来源

每条记录必须保存规划来源和版本。当前仓库优先读取 Solo Dev Loop 的 `docs/NOW.md` 计划快照；其他项目只有在存在明确、可读取的规划来源时才计算百分比。

没有可验证规划来源时，进度为 `unknown`，不允许 AI 猜测分母。

## 5. 任务生命周期

```text
create
→ before_snapshot
→ running
→ exited / stopped / failed / interrupted
→ after_snapshot
→ validation
→ handoff_written
→ accepted / needs_review / rejected
```

### 5.1 任务开始

任务开始前记录：

- `task_id`、`run_id`、创建时间；
- 任务原文的安全摘要或受控引用；
- 活动项目 `project_id`、`repoRoot` 和相对路径；
- 分支、HEAD、工作区状态和可用 Git 摘要；
- 任务开始前已经存在的改动；
- `plan_source`、`plan_revision`、完成项、总项和进度；
- 受保护路径和本次允许写入范围。

### 5.2 执行期间

按递增 `seq` 追加：

- `task_created`；
- `before_snapshot`；
- `pi_started`；
- `output_chunk` 的脱敏、截断摘要；
- `state_changed`；
- `pi_finished`、`stopped`、`failed` 或 `interrupted`。

客户端断开只取消订阅，不停止 Pi；服务负责继续记录到任务终态。

### 5.3 执行结束

执行结束后，产品获取后置 Git 快照，记录：

- 分支和 HEAD 是否变化；
- 暂存、未暂存、未跟踪文件；
- 任务期间新出现或状态改变的路径；
- 既有改动与本次观察到的变化；
- 无法因果归属的并发变化。

系统只能说“运行窗口内观察到变化”，不能声称变化一定由 Pi 造成。

### 5.4 验收与收口

Pi 不再运行后，用户可确认少量验收命令。产品逐条执行、记录退出码，并生成交接文件。验收失败、跳过或未完成时仍必须写入记录。

## 6. 证据模型

### 6.1 事实等级

```text
verified                 Git、系统命令、测试退出码等直接观察事实
user_confirmed           用户明确确认的事实
agent_reported           Codex/Pi 自述，未独立验证
recorded_not_reverified  旧记录事实，本次尚未重新验证
unknown                  无法判断或证据缺失
```

只有 `verified` 和 `user_confirmed` 可以作为验收依据。`agent_reported` 不得写成“测试通过”。

### 6.2 Git 证据

Git 检查必须只读，至少包括：

- 项目根目录、分支和 HEAD；
- 暂存、未暂存、未跟踪文件状态；
- 前后快照的路径集合和状态变化；
- 任务开始前已有改动；
- 需要时的统计摘要或内容摘要哈希，不保存完整 diff。

### 6.3 验收命令

验收命令由用户在执行前看到并确认。命令使用“程序 + 参数”模型启动：

- `shell: false`；
- cwd 固定为活动项目根目录；
- 拒绝管道、重定向、命令替换、环境变量注入和多命令连接；
- Pi 运行中不可并行执行；
- 有固定超时和输出上限；
- 不自动重试。

记录格式：

```yaml
command:
  executable: npm
  args: [test]
  cwd: .
  approved_by_user: true
  started_at: 2026-08-19T12:01:00+08:00
  finished_at: 2026-08-19T12:05:17+08:00
  exit_code: 0
  result: passed
  duration_ms: 4217
  output: redacted_excerpt_or_withheld_sensitive
```

### 6.4 秘密保护

- Key、Token、密码、私钥和环境变量不得进入项目记录、黑匣子或日志；
- 发现疑似敏感内容时，整段输出不落盘，并标记 `withheld_sensitive`；
- stderr 不进入用户可见错误文案；
- 命令参数和环境变量在写入前执行脱敏；
- 任何无法安全脱敏的记录生成失败，任务保留失败状态。

## 7. 任务状态与完成判定

执行、验证和用户验收分开记录：

```yaml
execution_status: exited | stopped | failed | interrupted
verification_status: passed | failed | partial | not_run
acceptance_status: accepted | rejected | pending
```

只有以下条件同时满足时，任务才可以标记 `accepted`：

```text
Pi 正常结束
+ Git 前后证据已生成
+ 必要验收命令全部通过
+ AI 交接文件成功写入
+ 用户明确验收
```

其他结果必须明确标记为 `needs_review`、`verification_failed`、`stopped` 或 `interrupted`。

## 8. AI 交接文件格式

### 8.1 当前交接 `docs/ai-ops/NOW.md`

```yaml
type: ai-handoff-current
schema_version: 1
project: AI·OPS COCKPIT
updated_at: 2026-08-19T12:00:00+08:00
current_task_id: task_example_001
task_status: accepted | needs_review | failed | stopped | interrupted

plan:
  source: docs/NOW.md
  revision: v0.1-r1
  completed: 4
  total: 6
  percent: 66.7

before:
  branch: main
  head: abc1234
  worktree: modified

after:
  branch: main
  head: def5678
  changed_paths: []

evidence:
  execution: verified
  git: verified
  validation: passed | failed | not_run | partial

facts:
  verified: []
  user_confirmed: []
  agent_reported: []
  recorded_not_reverified: []
  unknown: []

issues_and_risks: []
next_action: ""
latest_record: docs/ai-ops/records/task_example_001.md
```

### 8.2 历史记录 `docs/ai-ops/records/task_id.md`

历史记录必须包含：

- 任务目标和已确认决策；
- 允许范围和保护范围；
- 执行时间线摘要；
- 执行前后 Git 状态；
- 文档、代码、配置、维护和交接文件变化；
- 测试/命令及退出结果；
- 用户验收；
- 事实等级列表；
- 问题、风险和未决事项；
- 规划来源和进度快照；
- 唯一下一步；
- `source_run_id` 和黑匣子事件范围。

历史记录只能追加，重名时拒绝覆盖。

## 9. 开发 AI 读取协议

Codex/Pi 接手项目时依次读取：

```text
AGENTS.md 中的受控入口
→ docs/ai-ops/NOW.md
→ latest_record 指向的历史记录
→ 记录引用的 PRODUCT、计划和决策文件
→ 对标记为过期的事实重新验证
→ 只执行 next_action
```

开发 AI 不得：

- 把 `unknown` 当成完成；
- 把 `agent_reported` 当成测试通过；
- 修改历史记录；
- 扩大 `protected_scope`；
- 跳过 `next_action` 开始无关功能；
- 把交接文件自身变化算成产品功能完成。

## 10. 文件与模块边界

实现时只允许触及以下范围，具体文件名须在实现计划中再次确认：

- Pi 执行服务的任务生命周期和事件适配；
- Git 只读证据适配器或其扩展；
- 本地黑匣子持久化服务；
- 项目内交接文件生成器和脱敏器；
- 验收命令执行器及其认证/风险确认路由；
- 项目 view 的时间线、证据和交接状态展示；
- 对应 Node 测试、UI 静态回归测试和文档。

保护范围：

- `src/agent-caller.js`、群聊、终端、安装和护航主链路；
- `public/vendor/`、`.token`、真实 `.env`、`tools.json`；
- 用户现有工作区改动和未分类资产；
- 不必要的产品重构和框架迁移。

## 11. 风险与验证策略

风险等级为 `high`，因为切片会向用户项目写入文件，并在用户确认后执行验证命令。

实现前必须完成：

- 安全边界和命令执行威胁分析；
- 脱敏失败路径测试；
- 服务重启和中断恢复测试；
- 并发运行/断开连接/超时测试；
- 既有 Git 改动保护测试；
- 独立代码或安全审查；
- 用户真实项目上的一次端到端验收。

结构校验、自动化测试和 AI 声称通过都不能替代真实产品证据。

## 12. Definition of Ready 草案

进入实现前必须补齐并在 `docs/NOW.md` 记录：

- [ ] 用户确认项目内交接文件可进入 Git，但产品不自动提交；
- [ ] 目标、起点、终点和非目标已固定；
- [ ] 任务记录、黑匣子和交接文件的数据契约已批准；
- [ ] 验收命令的 argv-only 安全边界已批准；
- [ ] 现有文件和用户改动已有保护方案；
- [ ] 允许修改范围精确到文件；
- [ ] 现有 Pi、Git 和项目路由入口已确认；
- [ ] 自动、人工和负面验收证据已映射；
- [ ] high 风险安全审查、失败路径和回滚策略已列入实现计划；
- [ ] 唯一工作分支和基线已确定；
- [ ] 设计文档已由用户审阅。

本设计稿完成后，项目仍停留在 `design`，S04 不自动变为 `ready` 或 `active`。
