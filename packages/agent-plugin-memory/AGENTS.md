# AGENTS.md

Scope: packages/agent-plugin-memory。继承根规则；修改前读 docs/specs/architecture.md。

- 本包移植 Codex v2 两阶段记忆、来源优先级、预算、选择、失败恢复与渐进读取；不拥有文件系统、HTTP、身份认证或 Core 调度。
- 多个 Agent 可共享同一个 MemoryPlugin；可信身份由宿主绑定，单轮状态按 Outcome 隔离。
- 原始 Chat 来源与临时模型上下文分开；生成的记忆不能重新成为人类证据。
- 派生的算法与提示词保留 Apache-2.0 来源标记、LICENSE 与 NOTICE。源码英文 JSDoc，内部 SPEC 中文。
- 验证 `bun run --filter @quifox/agent-plugin-memory check`，以及 Model/Session 与 shared-runtime 的真实 HTTP/持久化组合测试。
