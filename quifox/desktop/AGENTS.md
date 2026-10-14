# AGENTS.md

Scope: quifox/desktop。继承根规则，读 [共享 Host 合同](../runtime/docs/specs/architecture.md) 与 [Desktop 合同](docs/specs/architecture.md)。

- React 只提交共享命令并展示真实会话/轨迹；Rust 只拥有窗口、sidecar 进程与 JSONL 桥。
- Codex 为项目/会话/子任务导航的行为锚；DSH 为轨迹明细与展开的行为锚，不推断其未公开内部实现。
- 前端构建、Rust 检查、真实 Tauri 进程启动和原生 UI 截图验收分别报告；浏览器预览不等于原生验收。
- strict TS 与根 lint/testlint 不绕过。验收 `bun run --filter @quifox/desktop check`，以及当前宿主的 `desktop:build`/原生启动。
- 设置与插件页面复用 ui.tsx 的语义状态组件和 tokens.css，不以裸段落充当加载、空态、错误或提示。自定义插件 surface 只渲染 Host 公开投影，不建立另一状态 owner。
- 业务 JSX 不手写独立 p；状态、必要字段约束和正文使用对应语义组件。Markdown 渲染的段落正常保留。首期设置导航使用中文；普通设置按标签/控件左右排布，复杂编辑区域可占全宽。
