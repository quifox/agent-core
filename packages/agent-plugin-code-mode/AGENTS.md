# AGENTS.md

Scope: `packages/agent-plugin-code-mode/`。先读根 AGENTS.md 和本包 `docs/specs/architecture.md`。

- 本包拥有 Code Mode 工具、宿主绑定注入与原 Tool 对象的异步代理调用；不修改 Core、Registry、CTX 或模型接口。
- 执行器由 Host 注入；生产包不使用 Node、eval、动态 import、文件系统或隐式网络。
- 工具代理通过公开 ToolRegistry 读取同一原对象，编排现有插件的 beforeTool/afterTool；不导入 HookRunner 或内部 executor。
- 插件热更新由 composition 包拥有；本包可独立使用。setNextPlugins 是 Host 通过 bindings 注入的组合示例，不是本包内置绑定或必需依赖。
- 公开入口 src/index.ts；ES2022 ESM、strict TypeScript、四空格、英文 JSDoc；人类用法维护本包 README.md，中文 README.zh-CN.md 从英文同步；共同开发契约链接根指南。
- 验证：`pnpm --filter @quifox/agent-plugin-code-mode check` 与真实 Core/Session/Composition 组合测试。
