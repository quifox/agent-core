# 最小 Core 与插件边界的已采用决定

状态：implemented。本文保存既有决定与必要原因；当前行为只以链接的 SPEC、源码和测试为准。记录日期表示整理日期，不表示每项决定都在当天提出。

## 状态与返回

- 选择 Agent 生命周期复用 CTX，以承载插件长期协作能力；每次调用用独立 Outcome 关联接纳和收尾。此前每次运行重建 CTX 会混淆初始化与运行生命周期；Core 内的 active 拒绝也会在接纳插件之前阻断输入转向。因此接纳、计步、中断与恢复状态归插件。
- 统一采用 AgentRunOutcome；正常生成时 value 直接保存原始 ModelTurnResult。此前分离的 AgentRunResult、AgentStopReason / stopReason 与供应商结束原因映射，会把插件策略重复放入 Core。
- 保留原模型结果合同；未采用 ModelTurn、action: 'exit' 或额外 value 包装方案。这些方案超出当时的精简目标，还会要求生成与消费插件额外适配。

当前合同：[Core 架构](../../../../packages/agent-core/docs/specs/architecture.md)、[对象生命周期](../../../../packages/agent-core/docs/specs/sessions.md)。

## 工具、观察与组合

- 工具自身拥有 prepare/execute 与业务反馈；移出 createInputRepair、参数错误文案和通用业务结果校验。prepare 是通用前置方法，是否处理问题并继续、还是抛错，由实际实现决定；过早的 Core 校验会阻止后续 Hook 合法改写。
- 使用既有 Hook、显式插件和 Host 能力协作；未把 onEvent、beforeUserMessage、beforeToolExecute、ModelContext 提交协议、PluginRegistrationContext 包装或通用 Session 门面纳入 Core。它们不是各插件必须实现的隐含合同。
- 插件排序由实际对象数组表达；未采用 Core 自动依赖排序、priority 或统一 middleware next()。常用关系可由组合对象集中配对，明确契约并验证顺序，第三方仍可选择自己的组合。
- 通用系统提示词插件只注入调用方显式提供的内容；产品身份与诊断提示词放在对应 Host，避免通用包继承某个产品。

当前合同：[工具入口](../../../../packages/agent-core/docs/specs/tool-runtime.md)、[跨包架构](../../../../docs/specs/architecture.md)、[提示词插件](../../../../packages/agent-plugin-system-prompt/docs/specs/architecture.md)。推荐做法：[插件开发指南](../../../../docs/guides/plugin-authoring.md)。

## 原工具复用与插件重组

- 后续在「查找 DSH 核心 Agent Loop Wiki (2)」中批准 ToolRegistry.get/values：读取原 Tool 引用，调用方法及是否先 prepare 由使用者决定。此前“所有执行必须经过 Core 入口”的表述只适用于默认循环，不能限制调用者复用同一工具对象。直接调用不自动获得 Core Hook、事件或 Run 语义。
- 插件重组采用真实对象数组与最后 onRunEnd 自动交接，替代 plugins_list/plugins_set、脚本句柄、loadPlugin/applyPlugins 和手动 apply 方案。Host 仅提供 replaceAgent，代码执行与额外绑定由 Code Mode/Host 负责；保持普通 Agent 引用，不添加 Core 动态安装接口或 Runtime 包装。
- Composition 与 Code Mode 不内置并发 Run 拒绝。接纳与排程由另一个显式插件选择，不能以管理插件便利为由重新引入 Core active 或能力插件的强制单轮限制。

当前合同：[Registry 读取](../../../../packages/agent-core/docs/specs/tool-runtime.md)、[Composition](../../../../packages/agent-plugin-composition/docs/specs/architecture.md)、[Code Mode](../../../../packages/agent-plugin-code-mode/docs/specs/architecture.md)。

## 公开文档与研究定位

- README 与人类指南采用英文主版本并提供中文；SPEC 与内部设计只维护中文，英文路线图保持单语。根指南只讲共同开发契约，各插件独立维护包内用法。当前布局是一个独立仓库内的独立 packages，不因文档拆分推导多仓发布要求。
- 定位为实验性研究框架：以宽松 Context/Hook 和显式对象组合探索 Agent 能力；组合自由不代表任意插件兼容，也不代表生产就绪。DSH 可作相关研究链接，旧快照比较和评分不作为当前公开能力结论。

- README 只负责项目展示、解读与用法；语言优先级和维护规则放在 AGENTS。应用专属插件由外部应用独立维护，不纳入 Agent 源码与安装依赖；非必要关联保持匿名。未要求配置 CI，不用私有应用凭证作为基础安装或验证前提。

当前合同：[仓库与文档边界](../../../../docs/specs/packages.md)、[架构定位](../../../../docs/specs/architecture.md)。

这些决定不构成永久禁止新能力的清单。用户新要求或实际前提变化时重新评估；普通任务不从历史名称推导尚不存在的接口，也不为旧实现增加兼容层。
