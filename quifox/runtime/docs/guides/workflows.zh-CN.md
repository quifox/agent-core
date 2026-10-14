# TypeScript 工作流

[English](workflows.md) | [简体中文](workflows.zh-CN.md)

在插件页启用工作流插件后，typescript-workflows Skill 自动进入现有技能目录。Agent 可以渐进加载编写指南、可用业务插件、恢复说明和模板，不增加单独的文档工具。

脚本使用普通 TypeScript、agent().ask()、分支和 Promise.all，具名方法使用 JSDoc `@node 标签`（也兼容 `@phase 标签`）；同一 TypeScript Program 由固定版本的 [ZCode](https://github.com/zai-org/ZCode) 派生引擎分析与执行，无须维护图 JSON。初始图展示可解析的方法调用关系，不推断执行顺序或本轮必经路径。当前支持 agent、args、phase、log 与普通 TypeScript，不暴露上游 world/artifact/hole API；脚本没有 import 或直接网络/文件系统能力。

对话中的 dynamic-workflow 围栏渲染成工作流图卡。运行打开右侧测试面板，保存写入 ~/.quifox/workflows。顶级工作流页左图右对话，沿用现有多轮会话；左侧列出脚本和推荐模板，支持导入 .ts 文件并校验。图支持缩放、平移和适合窗口。运行后方法节点汇总已观测调用次数与状态，点击查看详情，也可切换“调用实例”观察嵌套、并行和循环的真实父子关系。静态边为虚线，真实调用使连线变为实线；动态派发在运行时补充实际关系。恢复和新回合各有独立执行身份，不混合旧状态。界面使用有限观测窗口，次数描述当前窗口内的记录。

[编写 Skill](../../skills/typescript-workflows/SKILL.md) 包含通用知识检索示例。并行模板改写追问、同时检索直接证据与冲突证据，再按来源回答，不固定考试、年份或知识库。每个工作流回合新建内部 Agent；同一回合复用变量保留其上下文。args.messages 只传入外层用户与助手输入输出。

检索示例使用本地 Mock，不连接知识服务。在插件市场安装**知识检索示例（Mock）**，它默认不安装。Agent 既可直接调用 knowledge_retrieve，也可用 agent("Research", {plugins:["knowledge"], tools:["knowledge_retrieve"]}) 装配。可测试“并行工作流如何保留独立上下文？”。Mock 用固定中英文关键词匹配几份工作流、并行研究与会话历史的合成资料，来源名称均带 [Mock]；可用 documentIds 缩小范围，无匹配返回空结果。不配置检索地址、密钥，不发起外部 HTTP 请求，不使用真实数据集；模型和权限仍使用正常 QuiFox 设置。

独立 KnowledgePlugin 接收 Host 注入的检索回调，返回 content、document 和可选 documentId/score，不绑定检索后端。Mock 运行只验证插件与工作流集成，不证明真实检索质量；回答需要明确标记模拟证据。

Host 在私有 workflow-runs 目录 fsync 检查点。中断后回到原会话恢复：从入口重放脚本，复用完成节点结果，内部 Agent 接回原 Session。详见[恢复合同](../../skills/typescript-workflows/recovery.md)。需要确定性控制流；任意 JS 堆不持久化，未知工具回执明确标记，不自动重做副作用。业务写入的 exactly-once 需要插件实现幂等键与对账。模板展示只读重试和并行汇合，不保证生产就绪。

工作流页可部署本地 API，获得 loopback URL 与私有 Bearer Token。POST /runs 传 question，返回 sessionId；GET /runs/:id 获取状态与输出，后续 POST 传相同 sessionId 追问；POST /runs/:id/stop 停止。关闭只隐藏弹窗，管理入口可重开同一个服务，停止 API 才关闭服务。部署固定保存当时的脚本，更新后需停止并重新部署。服务随 Host 关闭，不自动暴露公网。

单独的 LangChain 插件通过相同技能目录提供所给 v0.2 审阅包中的 7 个技能。在插件市场安装，并启用技能插件即可发现。官方 LangGraph 技能名称、API 原文和引用文件保留；workflow-production-design、workflow-release-checklist 是按需编写参考。此插件不安装依赖、不执行脚本；LangChain/LangGraph 应用使用自己的库，不能当作 QuiFox 工作流脚本执行。来源见 [NOTICE](../../skills/langchain/NOTICE) 与[官方技能集](https://github.com/langchain-ai/langchain-skills)。

QuiFox 维护工作流支持能力；生成脚本的业务决策归作者负责，诊断不会自动改写分支或提示词。

脚本子进程限制继承环境，但 Node VM 不是安全边界，只运行受信本地脚本。生产部署、外部写入幂等与平台故障恢复仍需应用级验证。
