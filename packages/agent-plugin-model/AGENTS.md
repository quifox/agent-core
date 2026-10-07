# AGENTS.md

Scope: packages/agent-plugin-model。先读根 AGENTS.md 和 docs/specs/architecture.md。

- 本包拥有模型插件及其内部协议、HTTP/SSE、参数解析与平台传输适配。用户配置并注册插件；不要求用户创建 Provider 或 LanguageModel。
- ChatModelPlugin 通过 model Hook 提供生成能力；Session 通过最小会话合同提供消息与请求接纳。模型插件不拥有历史、持久化、工具执行或运行调度。
- 底层客户端和工厂属于 internal 实现，不进入顶级能力列表、Core 入口或宿主示例；其他模型开发者实现自己的 model Hook。
- 保留协议解析、取消、工具参数与流聚合的真实语义；Fork 重新绑定 Session，不继承父运行取消信号。
- 英文公共文档、四空格 strict TypeScript ESM；只用 apply_patch 修改代码。测试脚本模型属于测试支持，不能冒充真实模型请求。
- 验证包 typecheck/test/build，以及 Session、压缩、后端和 Teams 的相关集成。
