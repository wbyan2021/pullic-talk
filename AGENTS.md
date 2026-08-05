# AI·OPS COCKPIT · AI 协作入口（Solo Dev Loop V4）

开始任何工作前，依次阅读：

1. [当前版本与唯一切片](docs/NOW.md)
2. [产品定位、现状与长期边界](docs/PRODUCT.md)
3. [代码地图、命令与风险边界](docs/CODEMAP.md)
4. [想法池](docs/IDEAS.md)——仅在记录或评审想法时打开

## 执行约束

- 优先级固定为：平台与安全约束 > 用户明确要求 > 本文件 > Solo Dev Loop 主流程 > 被调用专业 Skill 的内部流程。
- 同时只允许一个 active 版本、一个 active 切片和一个产品代码工作分支。
- 产品基线未确认时只做探索和产品设计；切片未达到 Definition of Ready 时只做设计、审计和验证准备。
- `docs/NOW.md` 未达到 Definition of Ready 前，不修改产品代码。
- 产品代码不得直接在 `main` 上开发；达到开工标准后，从记录的基线创建唯一工作分支。
- 设计、架构、安全、测试和计划等专业 Skill 只处理当前阶段的受限子任务，不能自行扩大版本范围、改变事实源或越过产品基线/Ready/Done 闸门。
- 风险等级取最高项；涉及凭据、付费服务、高权限执行、不可逆外部动作或用户数据时按高风险切片处理。
- 未知改动都视为用户资产，不覆盖、不丢弃、不使用破坏性 Git 命令处理。
- 不读取、输出或提交 `.token`、真实 `.env`、令牌、密码、私钥和本地个人数据。
- `tools.json`、`.token`、`node_modules/`、日志和缓存属于本地或生成内容；除非任务明确要求，不直接修改。
- `public/vendor/` 是本地化第三方依赖，只有明确升级依赖时才修改。
- 安装软件、执行传入命令或操作完整终端前，必须取得用户明确授权。
- 完成必须提供测试输出、实际操作结果或可检查产物；AI 自称通过不算证据。
- 需求变化先更新事实源，越过允许范围前先取得用户确认。

## 项目状态校验

```bash
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/inspect-project-state.mjs .
node /Users/bz01/.agents/skills/solo-dev-loop/scripts/validate-project-state.mjs .
```

进入构建、完成、合并、发布或归档前增加 `--strict`。

本文件只提供入口与安全约束；产品事实以链接文档和源码为准。
