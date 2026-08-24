---
type: design-spec
project: AI·OPS COCKPIT
milestone: v0.1-first-controlled-mission
slice: S04-evidence-and-blackbox
status: proposed
date: 2026-08-24
---

# S04 AI 交接状态一致性修复

## 问题

当前项目状态可以保存 `handoff.enabled: true`，但目标项目中的 `docs/ai-ops/NOW.md` 和 `docs/ai-ops/records/` 可能不存在。项目页面因此只显示“已启用”，不显示可操作的启用入口；同时，现有启用接口只写入 `AGENTS.md` 的受控指针，不能把交接入口恢复到可读取状态。

## 目标

让项目交接状态以“持久化授权状态 + 实际受控文件状态”为准：

1. 页面能区分“未启用”“已授权但文件缺失/需要修复”“已启用且文件就绪”。
2. 已标记启用但文件缺失时，用户能看到并点击“修复 AI 交接”。
3. 修复只创建缺失的受控文件和目录，不覆盖用户已有的普通 `AGENTS.md` 或非受控 `NOW.md`。
4. 初始 `NOW.md` 明确标记为 `needs_review`，不伪装为完成的产品任务，并包含唯一下一步。
5. 不改变 Pi 启动、停止、验收命令和黑匣子事件语义。

## 非目标

- 不自动启动 Pi，不自动运行验收命令，不自动提交目标项目 Git。
- 不覆盖已有用户交接文档、普通说明文档或 `AGENTS.md` 指令。
- 不把交接文件初始化计入产品功能完成或 S04 用户验收。
- 不处理其他项目，也不读取、输出或保存任何密钥、Token、密码、私钥或未脱敏 stderr。

## 设计

### 1. 交接文件检查

在 `src/services/ai-handoff.js` 增加只读检查能力，针对一个仓库返回脱敏的文件状态：

- `agentsPointer`: `managed`、`missing` 或 `conflict`；
- `current`: `managed`、`missing` 或 `conflict`；
- `records`: `present` 或 `missing`；
- `state`: `ready`、`repair_required`、`not_enabled` 或 `conflict`。

只根据固定路径和受控标记判断，不返回文件内容。

### 2. 安全修复

扩展显式启用/修复操作：

- 受控 `AGENTS.md` 指针缺失时，在用户点击后按现有原子写入规则补齐；已有普通内容只追加受控区块。
- `docs/ai-ops/records/` 缺失时创建目录。
- `docs/ai-ops/NOW.md` 缺失时创建一份最小、脱敏、`needs_review` 的当前交接；若已有受控文件则保留，不重置任务事实；若已有非受控文件则返回冲突，不覆盖。
- 操作成功后再持久化项目的 `handoff` 元数据，并在状态接口中返回实际文件状态。

### 3. 项目页面

活动项目的 AI 交接卡片按实际状态显示：

- 未启用：`启用 AI 交接`；
- `repair_required`：`交接已授权，但文件未就绪` + `修复 AI 交接`；
- `ready`：`已启用且文件已就绪`，显示当前交接和历史记录路径；
- `conflict`：显示冲突说明和人工处理建议，不提供覆盖按钮。

修复按钮复用认证的显式启用/修复接口，点击后刷新服务端状态。

### 4. 事实与证据

初始交接文档的事实等级只能是 `unknown` 或 `recorded_not_reverified`，任务状态为 `needs_review`，`next_action` 指向当前 S04 的真实验收。交接文件自身的创建不生成 Pi 任务证据，也不改变 S04 的验收状态。

## 允许修改范围

- `src/services/ai-handoff.js`
- `src/routes/project.js`
- `public/js/project.js`
- `test/ai-handoff.test.js`
- `test/project-routes.test.js`
- `test/project-ui.test.js`
- 本设计稿及对应实现计划

保护路径：`AGENTS.md` 未知用户改动、`projects.local.json.bak`、`.token`、真实 `.env`、`tools.json`、`node_modules/`、`public/vendor/`、其他项目目录。

## 验收标准

- [ ] 已启用但文件缺失的项目页面显示“修复 AI 交接”入口。
- [ ] 点击修复后，目标项目拥有受控 `docs/ai-ops/NOW.md` 和 `docs/ai-ops/records/`，页面显示 `ready`。
- [ ] 已有受控 `NOW.md` 内容和普通 `AGENTS.md` 内容不被覆盖。
- [ ] 非受控交接文件冲突时安全失败并给出人工处理建议。
- [ ] 初始化文档不包含秘密，不标记为 accepted/done，并保留唯一下一步。
- [ ] 相关自动化测试和全量测试通过；Pi 受控执行链路回归通过。

## 风险与回滚

这是涉及项目文件写入的 high-risk 修复。所有写入仍需用户点击触发，采用临时文件 + rename；任何冲突均停止写入。若页面或测试回归，可在当前产品分支回退本次修复提交，不触碰目标项目已有文件。
