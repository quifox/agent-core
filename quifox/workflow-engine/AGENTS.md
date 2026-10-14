# AGENTS.md

Scope: quifox/workflow-engine。继承根约束；本目录是应用内部的 ZCode 工作流引擎派生，不是新的框架公开能力。

- src 的上游分析器与运行 harness 保留 Apache-2.0、NOTICE 和原有格式；来源见 NOTICE。本地适配通过公开入口进入，不复制第三方私有应用、模型、认证、存储或 GUI。
- 编译期标准库由原构建脚本生成；不得用真实用户配置、会话或目录作为夹具。
- Node 子进程由 Host 拥有；框架工作流插件只接收执行能力，不导入本包。
