# Agent Core 架构规范

本文只固定 Core 的协议无关默认循环、钩子与收尾边界。跨包理念见 [Agent 架构与设计原则](../../../../docs/specs/architecture.md)，插件生命周期见 [sessions.md](sessions.md)，工具执行见 [tool-runtime.md](tool-runtime.md)。

## 职责

Core 只装配插件、调度有序钩子、转发插件事件，以及在默认循环中串行调用工具入口。Registry 可读取原 Tool 对象，直接方法复用的编排归调用者，边界见 tool-runtime SPEC。模型协议、消息、提示词、接纳策略、计步、阶段事件、结束原因、恢复与反馈属于插件或工具。Core 不隐式安装任何默认插件。

Core 保留直接可读的一个 while 和一个工具 for，不额外构造工作流引擎、重试引擎或会话门面。插件可在 onRunStart 中通过自己持有或注入的能力完成流程并 stop，默认循环不是必须进入的能力；Core 不承诺把内部 HookRunner 暴露为通用工作流 API。

## Context 与执行入口

- 一个 Agent 在构造时创建一份长期 Context，首次初始化和所有后续运行使用同一对象。run/stream 不复制、替换、清空或重新构造它。
- Context 提供工具注册表与最终有序插件对象数组。业务字段由插件明确扩展；Core 不固定 model/messages/step/runId/signal 等状态。
- onRegister 准备完整候选列表；onInitialize 按插件对象一次，运行钩子按数组位置执行。初始化完成后工具与插件集合固定。
- Core 不维护 active 或拒绝并发；插件自行实现拒绝、排队或其他接纳策略。持有单轮可变状态的插件必须落实自身契约。
- 每次 stream 创建一份 Outcome 对象，与长期 Context 是不同作用域。该对象原地更新，并作为 onRunStart 的第三参数、onError 的第三参数和 onRunEnd 的第二参数传递。插件只能收尾自己接纳的 Outcome；不能以 CTX 身份判断本次运行。
- run 完整消费同一条 stream 并返回其 Outcome；不另写一条执行链。

```ts
type AgentRunOutcome =
    | { ok: true; value?: unknown; errors: AgentError[] }
    | { ok: false; error: AgentError; errors: AgentError[] }
```

value 属于插件，Core 不解释其业务类型。已经是 AgentError 的主错误保留同一对象；其他抛出值以 cause 保留在规范化 AgentError 中。onError 和 onRunEnd 自身抛出的附加错误记录在 errors。成功执行后的首个收尾错误成为主错误；run 正常 resolve 该 Outcome，调用方按 ok 处理。ok 表示执行链没有未恢复的异常，不保证工具业务成功、模型正常完成或团队目标完成。

## 钩子

共用 12 个扩展点：onRegister、onInitialize、onRunStart、beforeStep、beforeModel、model、afterModel、beforeTool、afterTool、afterStep、onError、onRunEnd。

- 注册和初始化返回 Promise<void>。
- 运行钩子返回 Promise，或可选异步生成器；生成器 yield 过程事件、return 原控制产物。事件只要求 type，完整形状属于生成事件的插件。
- model 按最终数组覆盖，最后一个实现生效；不合并输出流。进入模型阶段而没有实现时，结构性错误进入 Outcome。
- 控制钩子 continue 进入后续处理器，stop 结束本次执行；stop 可以携带不透明 value。具体 reason 的含义和产物由插件定义。
- beforeTool 的 result 跳过整个工具入口，包括 prepare，仍经过 afterTool。
- beforeModel 只接收 ctx，不接收 Provider 请求。model 直接返回模型插件的 `ModelTurnResult`，afterModel 接收同一个可变结果。

### 参数、控制和短路

| Hook | 参数 | 处理规则 |
|---|---|---|
| onRegister | 候选插件数组 | 每个对象一次，允许修改加载草稿 |
| onInitialize | ctx | 每个对象一次，注册工具和准备能力 |
| onRunStart | ctx, input, outcome | 接纳本次输入，continue / stop |
| beforeStep / beforeModel / afterStep | ctx | continue / stop |
| model | ctx | yield 增量事件，return ModelTurnResult；最后一个实现生效 |
| afterModel | ctx, result | 原地修改本轮结果，continue / stop |
| beforeTool | ctx, call | 改写目标/输入，continue / result / stop |
| afterTool | ctx, run | 整理同一回执，continue / stop；所有后项仍运行 |
| onError | ctx, error, outcome | 观察主错误；所有后项仍运行 |
| onRunEnd | ctx, outcome | finally 收尾；所有后项仍运行 |

普通控制链按插件位置、再按 handler 位置执行；stop 或 beforeTool.result 短路当前链，后项不会执行。缺省处理器等价于没有贡献；实现了控制处理器时必须显式返回合法决定，不用 undefined 表示 continue。

afterTool 是回执整理屏障：即使某个 handler stop 或抛错，仍调用后续 handler。链结束后优先传播首个异常；没有异常时采用首个 stop。工具已经产生的副作用不因此回滚。

### 事件交付时机

model 的 yield 经委托实时转发。其他控制 Hook 的生成器先由 Core 消费并缓存事件，当前控制链完成后才交给消费者；消费者不能通过在这些事件上 break 阻止已经执行的后续 handler。afterTool 同样先完成整条回执链；onError/onRunEnd 事件也在各自处理完成后交付。

publish 出口的即时通知属于事件插件自己的行为，不等同于 Core stream 的 yield 时机。

```ts
interface ModelTurnResult {
    text: string
    reasoning: string
    toolCalls: ToolCall[]
    usage: ModelUsage
    finishReason: ModelFinishReason
}
```

Core 只读取 toolCalls，并把完整结果原样放入成功 Outcome。文本、推理、用量与供应商结束原因属于模型合同及生成插件，Core 不校验或解释它们。

## 默认循环

onRunStart → beforeStep → beforeModel → model → afterModel → 串行 beforeTool/executeTool/afterTool → afterStep。

- afterModel 后读取最终 toolCalls；实际调用最多进入一次工具 prepare/execute。
- afterStep 后读取本轮结果的 toolCalls；非空则进入下一轮，为空则结束默认循环。afterStep.continue 本身不强制再运行一轮；finishReason 不参与 Core 判定。
- 工具调用 ID 是关联真实回执的身份，不允许钩子修改；最终目标按 Registry 绑定其准备、执行和 policy。
- afterTool 的所有处理器都获得真实结果，整条链完成后才能应用 stop/错误或 yield 缓冲事件。不能因观察消费者关闭而遗漏会话回执保存。
- stop 退出整个循环，不只退出工具 for。未开始的调用不伪造成功或未执行回执；未知副作用由插件核实。
- stop 携带 value 时使用该产物；没有 value 时保留最近的模型结果，尚无模型结果则为 undefined。reason 不是 Core 的 stopReason，不自动进入 Outcome；需要返回原因的插件自行提供 value。

## 错误、观察与收尾

错误码和阶段使用开放字符串。Core 只声明自己的执行默认值；模型协议专用元数据属于模型插件。已有 AgentError 在错误与收尾链中保留对象身份、错误码与阶段。

- 模型、工具、钩子或已装配后的初始化错误进入 Outcome，再调用 onError。
- finally 统一调用 onRunEnd；所有收尾处理器获得机会。onError 自身失败不能阻断收尾，附加错误不能覆盖主要错误。
- onRegister 尚未完成时没有运行钩子集合：失败返回错误 Outcome，不调用未注册的运行钩子；失败初始化不自动重放。
- 消费者提前 return/break 时仍关闭委托生成器并收尾。提前关闭以 StreamClosedError 表达事件输送事实，业务停止产物由插件定义；正常消费者关闭不再次调用 onError。
- finally 中不 yield；完整消费者在收尾后接收缓存事件，提前关闭的消费者不再接收事件。
- step、模型阶段状态与错误展示事件由显式事件插件提供；Core 只发出 run-start、工具入口前的 tool-start、完整整理后的 tool-result 与收尾后的 run-end 执行事实，此外原样转发插件事件。
- AbortSignal、网络取消、系统提示词、持久化、重试、团队调度、运行期插件安装不属于 Core。

完整消费的结果顺序是执行/错误观察 → onRunEnd 全链 → 收尾事件 → Core run-end → 生成器 return Outcome。提前关闭不会继续模型或工具循环；尚未启动的 stream 直接关闭，不会初始化或产生运行钩子。

## 行为验收

- [注册测试](../../test/registration.test.ts)：长期 CTX、一次初始化、动态候选和 model 覆盖。
- [Hook 测试](../../test/hooks.test.ts)：原地改写、短路与事件缓存边界。
- [工具测试](../../test/tools.test.ts)：工具自有准备、返回与抛错、回执全链整理。
- [生命周期测试](../../test/lifecycle.test.ts)：原始模型结果、Outcome 身份、错误和 finally 收尾。
