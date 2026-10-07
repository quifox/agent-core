# @quifox/agent-core

[English](README.md) | 简体中文

协议无关的 Hook-driven ReAct 内核。创建 Agent 后复用整组插件对象；stream 返回过程事件，run 消费同一条流取得终态。

公开接口位于 [index.ts](src/index.ts)，仓库分包边界见 [包规范](../../docs/specs/packages.md)。

## 执行流程

```text
onRegister：调整候选插件列表
→ onInitialize：首次初始化与工具装配
→ onRunStart：本次新输入
→ beforeStep
→ beforeModel(ctx)
→ model(ctx)：yield 事件，return 本轮结果
→ afterModel(ctx, result)：共享可变结果
→ beforeTool
→ 工具执行入口（内部 prepare(ctx, input) → execute）
→ afterTool
→ afterStep
→ 下一次模型阶段或 onRunEnd
```

model 由插件实现，Core 不直接构造供应商请求。Session 插件可在 afterModel 保存 assistant 消息、在 afterTool 保存工具结果；消息列表、保存版本和 Fork 由插件自己决定。

插件可以直接 new，也可通过普通函数或明确共享对象创建。Core 不调用 createSession/createContext 工厂，不要求 UUID 或从类名自动生成 ID；after 只作关系声明，数组决定顺序。

Context 与普通钩子工作对象默认共享可变。beforeModel 不接收请求；afterModel 接收生成器最终 return 的结果，而不是生成器。控制返回 continue/stop；工具前 result 表示提供结果并跳过真实业务执行。

工具自己定义 prepare，负责校验、转换和其他准备；准备结果留在工具执行边界内。Loop 不拆分准备与执行，也不规定 repairInput 字段。

停止、输入转换、提示词、工具入口、压缩、存储与恢复由相应插件实现。Core 不提供固定消息列表、模型客户端、runId、signal、onEvent、后台 Idle 或运行期安装接口。

## 长期合同

- [架构与公开签名](docs/specs/architecture.md)
- [注册、初始化、对象复用与 Fork 边界](docs/specs/sessions.md)
- [工具准备、Registry 读取与回执](docs/specs/tool-runtime.md)
