# AGENTS.md

Scope: `packages/agent-plugin-composition/`。先读根 AGENTS.md 和 `docs/specs/architecture.md`。

- 本包拥有真实插件数组的暂存与最后收尾交接；Host 只提供引用替换回调。Core 不增加动态安装接口。
- 用法、对象复用、失败与末尾顺序的权威合同在本包 SPEC；人类用法维护本包英文 README.md，中文 README.zh-CN.md 从英文同步；共同开发契约链接根指南。
- 接收真实插件数组，最后的 onRunEnd 创建新 Agent 并调用 replaceAgent；不增加 Runtime、Proxy 或通用依赖管理。既有替代方案的原因按根 AGENTS 路由读取决策 Note。
- Host 可用普通引用容器、闭包或自身类持有当前 Agent；提交窗口、run/stream 的引用语义与新 Agent 初始化按本包 SPEC，不把 runtime 容器提升为 Core 能力。
- 公开入口 src/index.ts；ES2022 ESM、strict TypeScript、四空格与英文 JSDoc，无 Node、eval、文件系统或隐式网络依赖。
- 验证：`pnpm --filter @quifox/agent-plugin-composition check`；测试使用真实 Core 与末尾收尾失败场景。
