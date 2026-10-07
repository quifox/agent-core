# Code Mode 合同

Code Mode 是外部插件，注册普通 execute_code 工具，执行器由 Host 注入。

## 公开能力与执行器

- options 提供 execute(code, environment) 与可选 bindings(ctx)。environment 包含真实 ctx、按注册名生成的异步 tools 代理及 Host 能力。
- JS/TS 求值、编译、import、隔离、权限、时间和资源限制归执行器。生产包不提供 eval、Node、网络、文件系统或动态加载器。
- 真实对象与函数需要同进程执行器或显式桥接，JSON Worker 不自动传输可执行插件。使用裸变量示例时，执行器将 environment 各项绑定为源码变量。
- bindings 在执行时计算；之后由插件提供 ctx/tools，这两项仍是实际对象与代理。
- await 工具回执并返回有效摘要。字符串直接成为外层 content；其他值用 JSON 序列化，原值进入 data；undefined 使用完成文案。序列化异常沿已有工具错误边界传播。
- 本包可独立使用。setNextPlugins 是 Host 在组合 Composition 时提供的可选绑定，不是内置方法；它遵守该包的运行窗口与收尾合同。
- 生成 Hook 使用该 Hook 当前 ctx；执行结束后原 tools 代理失效。插件不注册增删/列表/加载工具，也不创建 Runtime 包装。

## 工具代理与 Hook

- 每次 execute_code 从同一 Registry 的 definitions/get 生成代理，名称取实际注册名，不从插件 ID 猜测。
- `tools[name](rawInput)` 是异步调用，包含 Promise.all 在内也串行排程；外层等待已排队调用收尾。
- 代理读取原 Tool，按序调度实际 beforeTool，再调用目标 prepare/execute，最后完整调度 afterTool。
- result 跳过 prepare/execute，仍进入 afterTool。stop 阻止后续代理调用，外层回执报告 CODE_STOPPED，并在外层 afterTool 传回停止决定。
- 代码/执行器自行处理工具或 Hook 异常；逃出 execute_code 的异常进入 Core onError/onRunEnd。不增加结果校验或强制 repair。
- 子调用 ID 关联外层且避开当前模型轮原生 ID。子事件/回执缓存到外层 afterTool/onError 后交付，不表示新 Core Run 或即时嵌套流。
- Session 保存外层代码回执；未匹配子调用不自动成为模型工具消息。代码自行返回摘要。
- 原 ctx.tools.get(name) 方法保持自由调用，不自动具有代理/Hook 能力。
- 被代理调用的工具/Hook 不等待同一串行代理队列，使用当前原 Tool 方法或自身服务，避免自等待。execute_code 自身不生成代理，重定向回它会被拒绝，避免递归死锁。

## 生命周期

本包不接纳、拒绝或排队 run；每个进入 onRunStart 的 Outcome 保存独立状态，错误/收尾处理匹配该状态。不同 Agent Context 的共享不会覆盖另一名成员；同一 CTX 重叠物理运行的协调归独立插件。

onRunEnd 释放本轮决定和事件。本包不提供检查点恢复、团队完成条件、Provider 适配或第二注册表，Core 行为与公开导出不变。
