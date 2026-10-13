# AGENTS.md

Scope: packages/agent-plugin-events/。先读根 AGENTS.md 与 docs/specs/architecture.md。

- 单 Agent 的独立事件发布插件；依赖 Core 公开事件、Hook 与模型类型，不依赖 Teams、SSE 或具体模型协议。
- 默认每个 Agent 创建独立 EventPublisherPlugin 实例。同一实例可随同一 Agent 串行复用，但当前不支持被多个 Agent 共享后并发观察；需要聚合时由出口汇总多个 sourceId，不共享插件运行状态。
- model 委托前面的生成钩子，原样交回增量及最终结果；消费者提前关闭时必须关闭上游生成器。
- 原 Agent 的 run/stream 方法不被包装或替换；发布失败不改变执行决策，可读取发布错误。
- 严格 TS、ES2022 ESM、英文 JSDoc，无 Node 或隐式网络依赖。验证 `bun run --filter @quifox/agent-plugin-events check` 和真实 Core 组合测试。
