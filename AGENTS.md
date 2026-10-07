# AGENTS.md

Scope：整个 Agent Monorepo。修改包前，沿祖先链读取该包 AGENTS.md 与其路由的模块 SPEC；涉及设计理念、能力组合或跨包职责时读 [跨包架构与设计原则](docs/specs/architecture.md)，仓库与 package owner 见 [包与仓库边界](docs/specs/packages.md)。

- 包名与公开入口以 packages/*/package.json 为准。顶级能力只有 Core 与插件包；模型连接、协议适配和底层 Provider 实现归模型插件包内部，不作为调用方需要组装的独立能力。应用专属集成与依赖属于宿主仓库。
- Core 是协议无关的循环与钩子调度器；会话、模型请求、提示词、恢复、中断、压缩和团队调度归插件。当前边界以 Core 与各插件 SPEC 为准。
- 插件对象保持共享可变语义；数组定义执行顺序。不能为迁移引入行为改变、自动重排或防御性副本。
- 长期行为或 owner 变化先改最近的 docs/specs；源码、测试和运行事实证明实现，不把计划与日志写入 SPEC。公开依赖从包入口导入。
- 面向读者的 README 与指南放在 README / docs/guides，以英文 .md 为维护主版本，提供中文 .zh-CN.md。CONTRIBUTING.md 只维护英文。SPEC 与内部设计约束只维护中文单语 .md，放在对应 owner 的 docs/specs；不保留英文副本或语言切换。ROADMAP.md 只维护英文。JSONL 只核对人类最终决定，不复制整段讨论。
- README 只展示项目定位、能力、简要设计解读、实际用法与导航；不放文档维护、语言优先级、提交/发布规则、CI 或验证门禁。维护规则留在 AGENTS，行为合同在 SPEC，贡献流程在 CONTRIBUTING。
- 非必要的外部应用关系使用匿名示例，不披露私有仓库名称、地址或项目身份。默认入门示例优先 Chat 协议；当前示例采用 DeepSeek，模型名称以官方文档核对。
- 通用示例与验证脚本使用 MODEL_API_KEY、MODEL_BASE_URL、MODEL_ID。保留 DeepSeek 示例及必要协议标识；其他非必要厂商或平台名称不进入文档、配置、注释、脚本名和测试夹具。
- 基础 Chat 示例完整创建 Session、Model 和 Conversation，向 Agent 注册 Conversation 组合。Model 插件直接接收模型名称、连接和认证参数；示例不创建 Provider 或传入底层模型对象。
- 入门 Hello World 使用现有模型插件发起真实请求，由模型生成输出；不改成固定文本 Hook。HTTP 夹具验证只证明协议与调用链，不能表述为真实模型验证。
- 编辑源码与文档只使用 apply_patch；不通过 Python 或替换脚本批量改写文件。README 示例省略环境文件加载过程，不将 process.env 表述为自动读取文件。
- 未经用户明确要求不新增 CI 流程；不得以开源整理为由要求 Agent 仓库配置私有应用凭证。
- 根插件开发指南只维护共同契约；各插件的用法放在自己的 package README/guide，组合示例链接参与方。项目以实验性研究框架展示，不宣称已建立生产就绪保证。
- SPEC 保存当前长期合同，开发指南保存用法与踩坑说明；已采用/拒绝方案及必要原因集中于 `.agents/notes/`。涉及旧接口、替代方案或重新决策时按需读 [Core 与插件边界决策](.agents/notes/implemented/architecture/2026-10-07-minimal-core-decisions.md)，普通实现不全量加载历史。
- 保持 ES2022 ESM、strict TypeScript、四空格；面向读者的英文说明、代码示例、JSDoc 与提交文案使用英文，SPEC / 内部设计和用户沟通使用简体中文。文档整理不批量改写已有源码注释。生产包无 Node、文件系统、process 或隐式网络依赖；示例 Host 单独拥有 Node I/O。
- 不提交真实 ENV、密钥、个人对话、用户数据、设备路径、日志和构建产物。测试与演示使用合成数据。
- 仓库源码采用 MIT License；GitHub 可见性与 npm 包发布仍分别授权。根 workspace 保持 private，具体 package 只有在明确发布时才移除 private。
- 最低 Node 22，pnpm 版本固定在根 package.json。先 pnpm install --frozen-lockfile，再 pnpm build；按改动选择类型检查、测试与构建，避免无关全仓重复验证。
- 覆盖率入口为 pnpm test:coverage；统计范围以 vitest.coverage.config.mjs 为准。按语句、分支、函数和行分别统计，总量汇总文件计数而非平均包百分比；实际百分比不写入项目记忆。
- 初始导入后 main 只通过短期分支与 PR 更新。改动完成后使用一个独立 reviewer，主实现者核验其证据；未经用户要求不创建 Release 或公开仓库。
