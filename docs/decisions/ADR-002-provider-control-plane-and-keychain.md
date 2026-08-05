---
type: adr
project: AI·OPS COCKPIT
status: accepted
decision: independent-escort-provider-adapter-with-macos-keychain
date: 2026-08-06
---

# ADR-002：护航控制面独立接入 Provider，凭据进入 macOS Keychain

## 状态

Accepted——用户于 2026-08-06 授权按 S01 设计继续工作。

## 背景

现有 `/api/chat`、`src/agent-caller.js` 和 `public/js/chat.js` 面向已经安装的 CLI Agent。护航 AI 必须在 Pi 未安装、未登录、配置错误或运行失败时仍能解释和诊断，因此不能复用一条会随执行 Agent 一起失效的调用链。

S01 同时要处理真实 DeepSeek API Key。Key 需要可保存、替换和删除，但不得进入仓库、普通配置、应用日志、浏览器持久化或可被进程列表看到的命令参数。

## 决定

1. 新增独立的 Provider Adapter 和 Escort Service；护航 AI 直接调用 DeepSeek，不经过 CLI Agent 调用器。
2. DeepSeek 是 S01 唯一实现的 Provider，但路由、服务和适配器保持明确边界，后续 Provider 通过新增适配器接入，不在 S01 预建通用插件平台。
3. API Key 保存到 macOS 默认 Keychain 的固定 service/account 条目。
4. 写入 Keychain 时调用 `/usr/bin/security add-generic-password ... -U -w`，把 `-w` 放在最后，并从子进程 stdin 输入 Key；Key 不进入 argv。读取结果只在服务端请求生命周期内使用，不记录、不返回前端。
5. 前端只获得 `configured` 与脱敏占位状态；输入框提交后立即清空，Key 不写入 localStorage、DOM 展示文本或聊天历史。
6. Provider 状态在内存中维护；应用重启后从 `unchecked` 重新检测，不把故障状态写入普通配置。
7. S01 护航只解释、诊断和给出下一步，不调用本机工具，也不得声称已经替用户执行操作。

## 结果

### 正面

- Pi 或其他 CLI 失效时，护航 AI 仍然可用。
- Provider、凭据、护航对话和旧群聊职责清楚，后续可逐步扩展而不重写旧功能。
- 不新增原生 Node 依赖，Key 由系统钥匙串保护，且避免出现在命令参数中。
- 适配器和服务可用假的 Keychain runner / fetch 做单元测试。

### 代价与残余风险

- 当前方案只支持 macOS；跨平台凭据库以后需要新适配器。
- Node.js 字符串无法保证用后从内存中立即抹除，只能缩短生命周期并禁止复制和记录。
- 用户的 Keychain 策略可能触发系统授权或不可用，产品必须显示 `credential_store_unavailable`，不能回退到明文文件。
- S01 不保存聊天历史，不提供黑匣子和工具调用；这些能力由后续切片负责。

## 备选方案

### 复用现有 CLI 群聊

不采用。它会把护航能力绑定到 Pi/OpenCode 等执行工具的安装、登录和输出协议，违背控制面独立的产品原则。

### 先构建完整多 Provider 插件框架

不采用。扩展性更强，但会把 S01 扩大为注册中心、Schema、迁移和多 Provider UI，无法在两个专注工作段内形成真实闭环。

### 内存保存或项目内加密文件

不采用。内存方案每次启动都需重填；项目内文件即使加密也会引入密钥管理和误提交风险，均不符合低门槛与凭据边界。

### 新增原生 Keychain Node 依赖

暂不采用。它增加安装和 Node ABI 风险；当前系统命令已经提供所需最小能力。若 stdin 写入或系统授权体验的真实原型不成立，再重新评估原生桥接。

## 参考

- [S01 护航 AI 独立上线设计](../plans/2026-08-06-s01-escort-online-design.md)
- [ADR-001：八个驾驶舱模块采用唯一事实所有权](ADR-001-cockpit-module-boundaries.md)
- DeepSeek 官方：[Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion)
- DeepSeek 官方：[错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes/)
