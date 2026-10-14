# AGENTS.md

Scope：整个 QuiFox Monorepo。修改包前，沿祖先链读取该包 AGENTS.md 与其路由的模块 SPEC；涉及设计理念、能力组合或跨包职责时读 [跨包架构与设计原则](docs/specs/architecture.md)，仓库与 package owner 见 [包与仓库边界](docs/specs/packages.md)。

## 项目开发约束与文档

- 根入口保存全仓稳定约束与读取路由；局部入口继承祖先规则，只补充对应 owner 的约束，兄弟模块不自动继承。
- 本节只管理开发指引；运行时 Memory 是已实现的独立插件能力，不能把开发文档维护当作重建或裁剪 Memory 插件。
- 本地配置、会话与插件资源的默认用户目录使用 `.quifox`，路径由 Host 的跨平台接口计算；测试使用隔离目录，不写入用户真实资料。
- 记忆在精不在多：同一内容只保留一份权威正文，优先更新现有文件；不按目录铺设入口，不为每次任务新增 SPEC 或决定记录。
- SPEC 保存现行长期合同；已确认取舍及必要原因沿用本地私有、Git 忽略的 `.agents/notes/`，不提交或链接其内容。源码、配置、测试和运行结果证明实现；计划、进度与单次验证留在任务材料中，决定已采用不等于功能已完成。
- 路由写明读取条件，路径相对所属入口；只加载任务涉及的 owner。更新或初始化记忆时适配 Harness 模板，保留项目约定，删除占位项与不适用章节；具体执行流程由 Skill 维护。

## 项目约束

- 包名与公开入口以 packages/*/package.json 为准。顶级能力只有 Core 与插件包；模型连接、协议适配和底层 Provider 实现归模型插件包内部，不作为调用方需要组装的独立能力。应用专属集成与依赖属于宿主仓库。
- Core 是协议无关的循环与钩子调度器；会话、模型请求、提示词、恢复、中断、压缩和团队调度归插件。当前边界以 Core 与各插件 SPEC 为准。
- QuiFox 的本轮能力与 Host 开发保持 Core 源码不变；Subagents、Skills、AGENTS.md、后台工具、TUI 与 GUI 都通过插件和 Host 组合实现。
- 展示品牌统一为 QuiFox / QUIFOX；包名、目录、命令、配置与应用标识使用小写 quifox。
- 插件对象保持共享可变语义；数组定义执行顺序。不能为迁移引入行为改变、自动重排或防御性副本。
- 插件与 CTX 保持开放；协作契约由每套插件集自行定义，不升级为所有插件的统一强制接口。自由度与协作约定的边界见跨包架构 SPEC。
- 面向长任务，不默认增加模型步数、运行总时长或任务总 Token 预算；模型上下文容量与具体 I/O 超时分别按实际边界处理。
- 长期行为或 owner 变化先改最近的 docs/specs；源码、测试和运行事实证明实现，不把计划与日志写入 SPEC。公开依赖从包入口导入。
- 面向读者的 README 与指南放在 README / docs/guides，以英文 .md 为维护主版本，提供中文 .zh-CN.md。CONTRIBUTING.md 只维护英文。SPEC 与内部设计约束只维护中文单语 .md，放在对应 owner 的 docs/specs；不保留英文副本或语言切换。ROADMAP.md 只维护英文。JSONL 只核对人类最终决定，不复制整段讨论。
- README 只展示项目定位、能力、简要设计解读、实际用法与导航；不放文档维护、语言优先级、提交/发布规则、CI 或验证门禁。维护规则留在 AGENTS，行为合同在 SPEC，贡献流程在 CONTRIBUTING。
- 非必要的外部应用关系使用匿名示例，不披露私有仓库名称、地址或项目身份。默认入门示例优先 Chat 协议；当前示例采用 DeepSeek，模型名称以官方文档核对。
- 通用示例与验证脚本使用 MODEL_API_KEY、MODEL_BASE_URL、MODEL_ID。保留 DeepSeek 示例及必要协议标识；其他非必要厂商或平台名称不进入文档、配置、注释、脚本名和测试夹具。
- 基础 Chat 示例完整创建 Session、Model 和 Conversation，向 Agent 注册 Conversation 组合。Model 插件直接接收模型名称、连接和认证参数；示例不创建 Provider 或传入底层模型对象。
- 入门 Hello World 使用现有模型插件发起真实请求，由模型生成输出；不改成固定文本 Hook。HTTP 夹具验证只证明协议与调用链，不能表述为真实模型验证。
- 编辑源码与文档只使用 apply_patch；不通过 Python 或替换脚本批量改写文件。README 示例省略环境文件加载过程，不将 process.env 表述为自动读取文件。
- 文档优先维护本次开发需要的入口与 owner SPEC；过时或已放弃包的低优先级文档不随任务全面整理。通用维护规则留在根入口，局部文档只保存差异。
- 未经用户明确要求不新增 CI 流程；不得以开源整理为由要求 Agent 仓库配置私有应用凭证。
- 根插件开发指南只维护共同契约；各插件的用法放在自己的 package README/guide，组合示例链接参与方。项目以实验性研究框架展示，不宣称已建立生产就绪保证。
- 开发指南保存用法与踩坑说明。涉及旧接口、替代方案或重新决策时，可按需读取本地私有决定记录；缺少记录时以版本化 SPEC 与用户已确认要求为准，普通实现不全量加载历史。未确定行为不写成现行模块合同。
- 保持 ES2022 ESM、strict TypeScript、四空格；面向读者的英文说明、代码示例、JSDoc 与提交文案使用英文，SPEC / 内部设计和用户沟通使用简体中文。文档整理不批量改写已有源码注释。生产包无 Bun/Node 专属 API、文件系统、process 或隐式网络依赖；运行时 I/O 归 Host。
- Host 与依赖选择兼顾 macOS、Linux、Windows；路径、进程与终端使用跨平台接口，不依赖特定 shell 或系统命令。本阶段不新增跨平台测试矩阵，不把本机通过表述为多平台验收。
- 不提交真实 ENV、密钥、个人对话、用户数据、设备路径、日志和构建产物。测试与演示使用合成数据。
- 仓库源码采用 MIT License；派生的 Memory 包保留其 Apache-2.0 LICENSE/NOTICE，见包 manifest。GitHub 可见性与 npm 包发布仍分别授权。根 workspace 保持 private，具体 package 只有在明确发布时才移除 private。
- Bun 版本固定在根 package.json，workspace 与锁文件分别以 package.json、bun.lock 为准。先 `bun install --frozen-lockfile`，再 `bun run build`；按改动选择 typecheck/test/check，局部命令用 `bun run --filter <包名> <脚本>`。工具链与运行时边界见包 SPEC，不将 Bun 能直接运行 TS 当成类型检查通过。
- 覆盖率入口为 `bun run test:coverage`；统计范围以 vitest.coverage.config.mjs 为准。按语句、分支、函数和行分别统计，总量汇总文件计数而非平均包百分比；实际百分比不写入项目记忆。
- 静态门禁为 `bun run typecheck`、`bun run lint` 与 `bun run testlint`，由 TS 配置和 eslint.config.mjs 维护；`bun run check` 组合构建、静态门禁与测试。Hook 允许只返回终值的生成器；闭包 owner 别名和显式 `_` 忽略值按现有合同检查，不为门禁重构 Core。
- 初始导入后 main 只通过短期分支与 PR 更新。改动完成后使用一个独立 reviewer，主实现者核验其证据；未经用户要求不创建 Release 或公开仓库。
