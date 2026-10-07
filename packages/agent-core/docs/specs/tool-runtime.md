# Agent Tool Runtime 规范

本文固定 Tool、Registry、工具前后 Hook 与真实执行的边界。Core 生命周期与事件交付见 [架构规范](architecture.md)，对象装配见 [插件生命周期](sessions.md)。应用 Runtime 适配、目录入口与业务权限分别由对应插件的 SPEC 定义。

## 所有权与默认执行链

Tool 提供模型可见定义、静态 policy、自有 prepare 和 execute。默认循环通过同一 ToolRegistry 绑定最终目标，调用 Core 工具入口；不拆开准备与执行，不持有 Prepared，不直接校验业务 ToolResult。下述执行顺序、Hook 和回执保证适用于这条默认链；Registry 原对象的自由调用见后文读取合同。

```text
beforeTool(ctx, call)
  → continue：具体工具.prepare(ctx, rawInput) → execute(prepared, ctx)
  → result：跳过 prepare 和 execute，使用插件提供的结果
  → stop：结束本次运行，没有当前结果
取得结果 → 完整 afterTool(ctx, run) → tool-result
```

工具未找到时返回最小 TOOL_NOT_FOUND 错误结果，仍经过 afterTool。prepare 或 execute 向外抛错时没有本次 ToolResult，不进入本次 afterTool，转到 onError → onRunEnd → 失败 Outcome。Core 不自动重试任何一条分支。

## Tool 合同

公开字段与泛型以 [tools.ts](../../src/tools.ts) 为准：

- name、description、inputSchema 定义模型可见工具；Provider 只投影这些字段。
- policy 保存 sideEffect、approval 和可选 retrySafe，不进入模型参数。
- prepare(ctx, rawInput) 是普通工具前置方法。可组织校验、转换、默认值、修复或资源准备，不专用于参数修复。
- execute(prepared, ctx) 接收同一个工具的准备产物与同一长期 CTX；具体业务 I/O、异常捕获和返回结果由工具实现。
- Prepared 可与 Schema 输出不同。Core 不重新 parse、转换、复制或解释该值；也不把它暴露为 Hook 工作参数。
- defineTool 省略 prepare 时提供 inputSchema.parseAsync；这个辅助的默认行为会抛 Zod 错误，不是 Core 对所有工具的强制错误策略。自定义 prepare 整体覆盖此默认行为。
- ToolSet 只用于显式装配，不是模型执行入口或另一份 Registry。

### prepare、错误反馈与业务操作

prepare 正常返回任何约定的 Prepared 后，注册项都会调用 execute；Core 不把“返回一个错误对象”识别成跳过 execute。工具可以把校验失败保存为自己的准备产物，再由 execute 返回 ToolResult，且不进行实际业务操作。

因此必须区分 **execute 方法被调用** 与 **业务操作发生**：

| 工具/Hook 的选择 | execute 方法 | afterTool | 本次运行 |
|---|---|---|---|
| beforeTool 返回 result | 不调用 | 完整执行 | 继续，除非后置 Hook 决定停止/抛错 |
| beforeTool 返回 stop | 不调用 | 当前调用不进入 | 结束并收尾 |
| prepare 向外抛错 | 不调用 | 当前调用不进入 | 错误观察与收尾 |
| prepare 内部处理问题并正常返回 | 调用 | 取得结果后完整执行 | 按后续 Hook 决定 |
| execute 返回 error/denied ToolResult | 已调用；业务是否发生由工具保证 | 完整执行 | Core 不据 status 判定 failed |
| execute 向外抛错 | 已调用；可能已有副作用 | 当前调用不进入 | 错误观察与收尾 |

不能从参数问题、error 状态或缺少回执自动推断异常已经抛出、业务没有执行或应当重试。字段文案、截断、业务反馈和严格校验由工具或显式 Hook 提供。

## Registry 与元数据

- 工具仅在 onInitialize 窗口注册/移除；最终名称非空且唯一，初始化结束后注册表固定。
- register 绑定当时的 prepare/execute 方法与源对象，并保存 policy 副本。后续修改调用方对象的方法或 policy，不替换已经登记的绑定。
- get(name) 返回注册时的原 Tool 对象，不存在时返回 undefined；values() 返回原对象引用的有序数组快照。只复制数组容器，不复制工具，不增加另一份注册表；初始化结束后仍可读取。
- policy(name) 返回对应静态策略的副本；修改查询结果不改变 Registry。definitions() 继续只返回模型描述；需要完整工具对象时使用 get/values。
- 通过 get/values 取得对象后，可以直接调用工具自己的方法。是否调用 prepare、传什么参数、如何组合 execute 都由使用者和具体工具约定；读取接口不包装方法、不解析参数、不强制调用顺序。动态名称读取无法保留每个工具的具体泛型，默认公开类型不对 Prepared/Data 作额外承诺。
- 直接方法调用不自动创建 ToolCall，不执行 beforeTool/afterTool，不生成 Core 工具事件，也不自动建立 Run/Outcome。调用方负责实际编排；异常只有传播到运行钩子时才进入该 Run 的错误与收尾流程。
- 读取原对象不改变已经登记的方法绑定或策略副本；替换原对象的方法不等于替换 Registry 的执行绑定。get/values 不增加运行时注册、删除、重试或受管调度接口。
- isRegistered(tool) 按源对象身份和名称核对；同名或相同 Schema 不是同一个注册事实。
- beforeTool 可改写 call.name 与 call.input。后续 handler 读取同一个可变 call，最终入口按新名称选择目标工具自己的准备、执行与策略。
- ToolCall.id 关联原模型调用与回执，禁止修改。路由插件负责保留原模型名称/输入的历史语义；Core 不因此另建调用包装层。
- Core 不按 approval 自动审批，也不按 retrySafe 自动重试。策略解释由准入、中断、恢复或宿主 owner 完成。
- retrySafe=true 由工具保证未知结果时安全重试；false 或省略不提供保证。幂等与核实仍由业务 owner 负责。

## 有序 Hook 与回执

beforeTool 严格串行：continue 才进入下一个 handler，result 短路本前置链并进入 afterTool，stop 退出整个运行。实际参数审批需要在工具准备后由工具与宿主完成，不能把准备前准入误称为最终参数审批。

afterTool 接收同一个可变 ToolRunResult；先前的结果修改对后项可见。任一 handler 的 stop 或异常都不阻止后续 handler 获得整理机会；整条链结束后才应用首个异常或首个 stop。会话和执行记录按自己所在位置保存当时可见版本，需要最终改写版本时由装配方明确安排顺序。

Core 不在 afterTool 前强制检查 result.status/content。自定义结果仍须由具体工具及消费它的插件兑现公开合同；没有校验不代表任何组合都能处理任意形状。

一个调用最多进入一次 prepare/execute；后置插件不重跑业务工具。串行 for 在当前调用和完整回执链完成后处理下一调用；中断不回滚已经确认的外部副作用。

## 停止、未知结果与恢复

- 协作停止由插件在 beforeTool、afterTool 等公开边界表达。工具内部操作的完成、取消信号与副作用语义属于其 I/O owner。
- beforeTool.result 可为未开始调用提供明确停止回执；这是一项具体插件策略，Core 不自动给剩余调用补“未执行”。
- 工具返回真实结果后先完成 afterTool，再向 stream 消费者交付回执；关闭消费者不会重放整理，也不会开始后续工具或模型。
- 未取得结果的调用不能伪装成成功或未执行。Snapshot/Fork 不复制 Promise 或正在执行的函数栈。
- Checkpoint 区分 not-started、started、completed；状态含义与重试判断属于执行记录及恢复策略插件。
- 显式恢复由 Session、Checkpoint 与策略插件合作，将待续调用重新交给原循环；已完成调用不重复。需要核实的调用先补真实回执，不因缺少回执自动重做副作用。
- Stream 提前关闭只触发必要收尾；它不等价于业务 pause、terminate 或持久化检查点。

## 适配器与业务安全边界

[工具入口插件](../../../agent-plugin-tools/docs/specs/architecture.md) 拥有目录、隐藏、查询与调用映射；映射后的目标仍回到同一 Registry。入口 handler 不嵌套执行器或直接调用目标 handler。

[Code Mode 插件](../../../agent-plugin-code-mode/docs/specs/architecture.md) 是另一种明确的调用编排：读取原 Tool，生成异步代理并调度既有工具 Hook。子调用身份、事件缓存、Session 回执和停止语义由该包定义；原对象的直接方法调用不自动具有这些代理能力。

应用适配器拥有具体工具及 Runtime 映射。Agent ToolCall.id 不作为业务参数；Runtime 自有调用 ID 缓存不代表 Agent 路径具有重放去重保证。确需传递内部调用身份时，应明确适配器内部合同，不塞入模型或业务输入。

approval、权限和 sideEffect 声明不能替代后端授权。UI、支付、账号或外部数据操作的真实安全边界由实际宿主与业务实现承担。

## 定义辅助与非目标

Tool/Hook 方法装饰器只记录声明元数据；toolsFrom/hooksFrom 显式绑定实例并生成现有合同。不使用 reflect-metadata、自动扫描容器或第二 Registry。

Core 不提供通用 repair、固定 Zod 文案、返回值校验层、反馈截断、Attempt 计数、重试引擎、并行工具、审批系统或 Artifact Store。

## 行为验收

[工具契约测试](../../test/tools.test.ts) 固定有序前置链、共享 CTX、私有准备产物、result/stop、工具返回与抛错、结果改写及串行执行。[生命周期测试](../../test/lifecycle.test.ts) 固定错误收尾和消费者提前关闭；[Checkpoint 组合测试](../../../agent-plugin-checkpoint/test/plugin.test.ts) 固定已完成跳过与未知结果恢复。
