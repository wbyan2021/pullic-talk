# 优化报告 · 2026-07-29

> 本文记录项目历次优化与改动，便于回溯。项目为 **AI·OPS DECK** — 桌面 AI 工具控制中心。

---

## 一、后端 `server.js`

### 安全加固
| 问题 | 修复 |
|---|---|
| 无输入验证 | `sanitizeChatRequest()`：空消息/超长消息（>8000 字符）返回 400；`targets` 白名单过滤；`thinking`/`mode` 非法值回退默认 |
| history 无长度限制（token 爆炸风险） | 历史最多 20 条、单条 ≤4000 字符、总长 ≤16000 字符 |
| prompt 拼接无上限 | 最终 prompt 兜底截断 32000 字符 |
| 非法 JSON body 泄露堆栈 | 错误处理中间件，统一返回友好 JSON |

### 稳定性
| 问题 | 修复 |
|---|---|
| 子进程无超时 | 默认 180s 超时（SIGTERM → 3s 后 SIGKILL），可配 `cli.timeoutMs` |
| ndjson 残留 buffer | 进程退出时补解析 |
| 客户端断开后无效写入 | `clientClosed` 标志 + flush 前检查 |
| Ctrl+C 孤儿进程 | 子进程注册表 + SIGINT/SIGTERM 优雅关闭 |
| 端口占用 | EADDRINUSE 友好提示 |
| 配置热加载失败 | 保留旧配置继续运行 |

### 可观测性
- 带时间戳的请求日志
- 超时 / 断开 / 热加载均有日志
- `/api/health` 含 `activeProcs` 字段

---

## 二、前端 `index.html`

### Bug 修复
- 加载历史会话时 markdown 显示为源码 → `renderMarkdown()` 渲染 + 代码高亮
- `@grok,帮我`（英文标点）无法识别 → 正则改用负向预测，中英文标点均可识别
- 错误提示顶着用户头像 → 新增居中灰色系统消息样式
- 流式期间关闭页面丢失对话 → 每个 agent 完成即自动保存
- 移动端侧边栏遮挡 → 移动端默认收起
- 浅色主题代码块仍深色 → 主题切换同步 hljs 样式
- localStorage 写满报错 → 捕获异常，自动淘汰旧数据
- 标题写死「三 AI」→ 动态显示 agent 数量

### 新功能
- **@ 自动补全**：输入 `@` 弹出候选列表，↑↓ 选择、Tab/Enter 补全
- **导出会话**：侧边栏「⬇ 导出」下载为 Markdown
- **响应耗时**：每条 AI 回复显示 `⏱ x.xs`
- **手动停止标注**：被中断的回复末尾自动加 *(已停止)*
- **XSS 防护**：DOMPurify 消毒
- **模式记忆**：并行/协作、思考深度持久化
- **多轮讨论**：右上角轮数选择器（1-5 轮），多轮时注入 persona
- **模型切换**：每个 agent 卡片下方模型下拉框，白名单控制

---

## 三、辩论 `run-debate.js` + `debate.json`

| 问题 | 修复 |
|---|---|
| 总结陈词看不到整场内容 | 新增 `{debate_history}` 占位符 |
| 结果不保存 | 实时增量写入 `debates/debate-日期.md` |
| server 没启动时堆栈报错 | 启动前检查 `/api/health`，友好提示 |
| 怪异分隔线 | 统一 `─` / `═` 分隔线 |

---

## 四、项目清理 · 2026-07-29

- 移除无关文件：`lru_cache.py`、`two_sum.py`、`__pycache__/`
- 完善 `.gitignore`：覆盖 `node_modules/`、`.DS_Store`、`__pycache__/`、`*.pyc`、`debates/`、`*.log`、`.env`
- 修复 `tools.json` 损坏条目

---

## 五、全屏终端页 · 2026-07-29

- 移除控制台页底部的内嵌终端 dock，改为独立全屏终端页 `/terminal`
- 控制台顶栏新增「▸_ 终端」按钮，快捷键 `` ` `` 一键跳转新标签页
- 工具卡片「启动」（command 类型）改为跳转 `/terminal?run=<命令>` 并自动注入执行
- 终端页特性：
  - 顶栏状态：连接 LED、shell 名、PID、尺寸、会话时长、时钟
  - 底部状态栏：字号缩放（⌘±）、复制、清屏（⌘K）、重启（⌘R）
  - 会话结束 / 断线覆盖层，一键重启；WS 自动重连
  - 字号持久化、主题与控制台同步、URL 可点击（web-links）
- 后端 `terminal.js` 连接时广播 `hello`（pid + shell）

---

## 六、使用提示

- 启动：`npm start`（或 `PORT=8080 node server.js` 换端口）
- 运行辩论：`node run-debate.js`（需先启动 server；结果存于 `debates/`）
- 加新 agent：编辑 `agents.config.json` 保存即热生效
- 扫描工具：`npm run scan`
- 删除会话/导出会话都在侧边栏
