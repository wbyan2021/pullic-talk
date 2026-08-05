---
type: product-flow-diagram
project: AI·OPS COCKPIT
status: confirmed-outline
updated: 2026-08-05
source_of_truth: false
source: ../plans/2026-08-05-ai-ops-deck-overall-design-review-draft.md
---

# AI·OPS COCKPIT · 完整产品流程图

> 本图把已经确认的产品大纲放到同一张主流程中，供整体阅读使用。它不是当前代码事实，也不替代产品总览。
> 标注“待设计”的节点不能直接作为开发要求；其中包括任务卡细节、点火、地面测试和第一次试飞。

## 1. 产品主流程

```mermaid
flowchart TB
    U["用户打开 AI·OPS COCKPIT"]

    subgraph P1["阶段一：初始设置与驾驶舱通电"]
        direction LR
        A1["环境、网络与基础服务检查"] --> A2["离线护航引导"]
        A2 --> A3["接入第一个模型能源<br/>默认推荐 DeepSeek"]
        A3 --> A4["凭据安全保存<br/>系统钥匙串"]
        A4 --> A5["护航 AI 独立上线"]
        A5 --> A6["安装或检测 Pi Agent"]
        A6 --> A7["同步兼容能源与 Harness 配置<br/>只补空白、冲突可回滚"]
        A7 --> A8["驾驶舱通电"]
    end

    subgraph P2["阶段二：认识与校准驾驶舱"]
        direction TB
        B1["护航 AI 说明全景与当前状态"] --> B2["最低必要校准"]
        B2 --> B3["综合自检与关键问题修复"]
        B3 --> B4["生成校准报告并保存配置"]
        B4 --> B5["进入待命"]

        B2 --- M1["总状态仪表"]
        B2 --- M2["资源与能力中心"]
        B2 --- M3["Agent 机组"]
        B2 --- M4["项目与任务系统"]
        B2 --- M5["飞行控制"]
        B2 --- M6["安全与自主策略"]
        B2 --- M7["工具与维护舱"]
        B2 --- M8["黑匣子与恢复"]
    end

    subgraph P3["阶段三：真实任务闭环（骨架已定，细节待设计）"]
        direction LR
        C1["用户提出真实目标"] --> C2["目标确认与任务准备<br/>具体任务卡待设计"]
        C2 --> C3["绑定项目或维护边界"]
        C3 --> C4["起飞前检查<br/>恢复点、范围、预算"]
        C4 --> C5["首版：单 Agent 执行<br/>护航 AI 监督"]
        C5 --> C6["观察、暂停、接管<br/>或处理关键决定"]
        C6 --> C7["结果验收与证据"]
        C7 --> C8["黑匣子报告、归档与恢复"]
    end

    subgraph X["贯穿全程的控制与安全底座"]
        direction LR
        X1["AI 护航：解释、诊断、下一步"]
        X2["统一状态与事件"]
        X3["可回溯安全区"]
        X4["保守自主与关键决定队列"]
        X5["本地数据、脱敏日志与凭据隔离"]
    end

    subgraph R["成熟后的扩展方向"]
        direction LR
        R1["多 Agent 机组"] --> R2["更多 Provider / Harness"] --> R3["夜航与高级恢复"] --> R4["远程控制、插件、团队能力"]
    end

    U --> A1
    A8 --> B1
    B5 --> C1
    C8 --> R1

    X1 -. "引导、解释、诊断" .-> A2
    X1 -. "引导、诊断" .-> B1
    X1 -. "监督、解释" .-> C5
    X2 -. "统一事实" .-> B3
    X2 -. "统一事实" .-> C6
    X3 -. "建立与检查" .-> C4
    X4 -. "仅关键风险等待" .-> C6
    X5 -. "记录与脱敏" .-> C8
```

## 2. 最低必要校准与渐进能力

```mermaid
flowchart LR
    READY["安全待命"]

    subgraph MUST["进入待命前必须可用"]
        direction TB
        M1["护航 AI"]
        M2["一个模型能源"]
        M3["一个 Agent"]
        M4["项目边界"]
        M5["暂停与紧急停止"]
        M6["恢复点"]
        M7["黑匣子记录"]
    end

    subgraph LATER["可在需要时渐进配置"]
        direction TB
        L1["额外 Provider"]
        L2["额外 Agent / 多 Agent 机组"]
        L3["搜索、浏览器、MCP 等 Harness"]
        L4["高级自动化与夜航"]
        L5["个性化面板与扩展接口"]
    end

    M1 --> READY
    M2 --> READY
    M3 --> READY
    M4 --> READY
    M5 --> READY
    M6 --> READY
    M7 --> READY
    READY -. "按实际需求加入" .-> L1
    READY -.-> L2
    READY -.-> L3
    READY -.-> L4
    READY -.-> L5
```

## 3. 首版与长期路线

```mermaid
flowchart LR
    V1["首个可用闭环\n一个项目 + 一个 Agent + 一条受控任务"]
    V2["驾驶舱完善\n八个模块逐步落地"]
    V3["能力扩展\n多 Agent、更多 Harness、夜航"]
    V4["平台成熟\n远程控制、插件、团队与商业化"]

    V1 --> V2 --> V3 --> V4
```

## 4. 阅读规则

- 实线表示已确认的主路径或依赖。
- 虚线表示跨阶段的护航、状态、安全和记录能力。
- “阶段三”只确认任务闭环的骨架；不表示任务卡、点火、试飞和验收的交互细节已完成设计。
- 多 Agent、远程控制和插件生态属于演进方向，不应阻塞第一条可控任务闭环。
