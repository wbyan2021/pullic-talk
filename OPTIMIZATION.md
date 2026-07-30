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

## 六、Bug 修复与加固 · 2026-07-30

| 问题 | 修复 |
|---|---|
| 首次打开聊天页欢迎屏不渲染（chat.html 预置空 `#welcome` div，`showWelcome()` 误判已存在直接 return） | 移除空占位 div |
| 危险命令规则 `\bformat\b` 误杀 `npm run format` / `prettier`（macOS 无 format 危险命令） | 移除该规则，改加 `diskutil erase`、`shutdown`、`reboot`、`> /dev/disk` 等 macOS 真实危险模式 |
| `/api/launch` app 名以 `-` 开头可被解析为 open 的额外参数 | 校验拦截 |
| 端口占用时 WSS 转发 error 事件无人监听，进程崩溃且看不到友好提示 | `wss.on("error", ()=>{})`，恢复 EADDRINUSE 友好提示 |
| CLI 输出无上限，失控进程可撑爆内存 | 单进程 stdout 上限 512KB（超限截断+SIGTERM），stderr 上限 64KB |
| 速率限制 Map 只增不减（内存泄漏） | 每分钟定期清理过期条目 |
| `/api/tools/scan` 无超时，脚本挂起则请求永远挂起 | 90s 超时杀进程 + 客户端断开联动终止 |
| run-debate.js 报错提示 `node server.js`（入口实为 src/server.js） | 改为 `npm start` |
| @mention 正则直接拼接 agent key，含特殊字符会匹配错乱 | key 转义后再拼正则 |
| 终端页 copyAll 死代码、控制台 activeElement 空值风险 | 清理 / 可选链防护 |

---

## 七、使用提示

- 启动：`npm start`（或 `PORT=8080 node server.js` 换端口）
- 运行辩论：`node run-debate.js`（需先启动 server；结果存于 `debates/`）
- 加新 agent：编辑 `agents.config.json` 保存即热生效
- 扫描工具：`npm run scan`
- 删除会话/导出会话都在侧边栏

---

## 八、可移植性 + 快捷安装 + P0 安全修复 · 2026-07-31

### 可移植性（换电脑后 AI 不一样怎么办）
| 改动 | 说明 |
|---|---|
| 新增 `src/agent-catalog.js` | 内置 8 个 agent 适配器（grok/pi/openclaw/opencode/codex/claude/gemini/qwen），装了哪个 CLI 自动亮哪个 |
| 重构 `src/config.js` | 内置目录 + `agents.config.json` 覆盖层合并；`which` 探测可用性（30s TTL 缓存） |
| `/api/models` | 新增 `available` / `path` / `source` / `installId` 字段 |
| `/api/health` | `agents` 只列本机可用；新增 `configured` 列全部已配置 |
| 群聊页 | 未安装 agent 灰显「未安装 ⬇」，点击直接一键安装；零可用时欢迎屏引导去快捷安装；@提及自动过滤不可用 agent |
| `run-debate.js` | 辩手本机不可用时明确报错并指引安装 |

### 快捷安装（控制台「快捷安装」页签 + 群聊页一键装）
- 新增 `src/install-catalog.js`：17 个热门条目（ChatGPT/Claude/Ollama/LM Studio/Jan/Cursor/Windsurf/VS Code/Warp/Codex/Claude Code/Gemini CLI/Aider/OpenCode/Pi/Docker/Homebrew），只收官方渠道
- 新增 `src/routes/install.js`：安装任务注册表（后台执行、日志缓存、重复提交复用、20 分钟超时、成功后自动刷新可用性+重扫工具）
- 安装方式自动择优：brew cask > brew > npm -g > 官网下载；无 brew 时页面顶部提示一键装 brew
- 新增 `public/js/installer.js` + `installer.css`：控制台与群聊页共用的安装弹窗（实时日志轮询）
- 控制台支持 `/?install=<id>` 直达开装（群聊页未安装卡片可跳转）

### P0 安全修复
| 问题 | 修复 |
|---|---|
| 终端/启动接口零认证，本机任意脚本可调用 | 启动生成随机 token（`.token` 0600），渲染页面时注入 `window.__OPS_TOKEN__`；`/api/*`（除 /api/health）与 WS 全部校验 |
| `/terminal?run=` 点链接即执行任意命令（RCE） | 必须先弹框显示完整命令、用户确认后才执行 |
| CDN 供应链风险（marked/hljs/purify/xterm 全走 jsdelivr） | 9 个文件全部本地化到 `public/vendor/`，CSP 收紧为 script-src 'self' |
| DOMPurify 加载失败时直接渲染未消毒 HTML | 现已不依赖 CDN；渲染函数保持「有则消毒」逻辑，后续可加纯文本降级 |
| WebSocket 无消息上限 | `maxPayload: 1MB` + 单条 input ≤64KB + run 命令 ≤32KB |
| `tools.json`（本机数据）入库导致 git 永远脏 | `git rm --cached` + gitignore；`.token` 一并忽略 |

### 其他改进
- `agent-caller.js`：`textType`/`textField` 支持数组（适配 codex 多事件格式）；`{model}` 为空时仅当前一项是选项才 pop；SIGKILL 补刀定时器随进程退出清理
- 主题 key 统一为 `ops-theme`（原 chat 页用 `tri-theme`，与控制台/终端不同步），读取时兼容旧 key
- 前端共享 `public/js/ops.js`（token + fetch 包装 + esc）；三页 fetch 统一走 `OPS.api`
- 群聊发送历史上限 6 → 12 条（服务端允许 20）
- `server.js`：三个重复的 watch 块抽成 `watchHtml()` 并加 watcher error 监听；修复 express.static 抢先响应 `/` 导致 token 注入失效（`index: false`）
- 补齐 MIT `LICENSE` 文件、`package.json` engines 字段
