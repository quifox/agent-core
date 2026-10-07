# 插件开发指南

[English](plugin-authoring.md) | 简体中文


本文说明实验性 Agent Core 研究项目中插件共享的开发契约。各插件在自己的包内维护使用文档。完整 Hook、Context、Outcome 与 Tool 合同以 [Core SPEC](../../packages/agent-core/docs/specs/architecture.md) 为准。

## 最小插件

```ts
import type { AgentHooks, AgentPlugin } from '@quifox/agent-core'

export class ExamplePlugin implements AgentPlugin<{ prompt: string }> {
    readonly id = 'example'
    readonly hooks: AgentHooks<{ prompt: string }> = {
        onRunStart: async (_ctx, input, outcome) => {
            // outcome 是本次调用身份；ctx 会在同一 Agent 的多次调用间复用。
            void input
            void outcome
            return { action: 'continue' }
        }
    }
}
```

Core 不按插件名称安装能力，也不自动解析依赖。调用方创建插件对象，并用数组顺序决定同一 Hook 的执行顺序。

## 设计检查

创建插件前明确以下合同：

1. **Owner**：插件唯一拥有哪份状态；哪些状态属于 Session、Tool、Model 插件或 Host。协议客户端属于模型插件内部，Core 只调用钩子。
2. **生命周期**：状态属于插件对象、长期 Context，还是一次 Outcome。Context 不能充当 Run 身份。
3. **Hook 顺序**：插件必须位于谁之前或之后；缺少协作插件时是失败、降级还是移除自己。
4. **并发**：同一对象能否被多个 Agent 或多个运行共享；拒绝、排队和合批由插件自己实现。
5. **失败**：返回 `stop/result`、返回业务 `ToolResult`，还是抛错进入失败 Outcome。不要让 Core 猜测业务错误。
6. **副作用**：开始、完成、未知结果、重试安全和恢复分别由谁判断。
7. **外部数据**：网络、存储、认证、SSE 和 UI 由 Host 注入，不使用隐式全局 I/O。

## Context 能力

插件可以通过明确的扩展接口在长期 Context 中发布能力：

```ts
import type { AgentContext, AgentPlugin } from '@quifox/agent-core'

interface ExampleContext {
    example?: { record(value: string): void }
}

const records: string[] = []
const plugin: AgentPlugin = {
    id: 'example',
    hooks: {
        onInitialize: async ctx => {
            const extension = ctx as AgentContext & ExampleContext
            extension.example = { record: value => { records.push(value) } }
        }
    }
}
```

宿主持有记录，插件发布记录能力。能力名、可变性、初始化时机和缺失行为必须写入插件 SPEC。不要用插件 `id`、类名或未声明字段猜测能力，也不要在多个插件中保存第二份权威状态。

## 对象身份与组合

- 同一插件对象默认保留共享可变语义；需要隔离时创建新对象。
- 每个 Agent 对同一对象只注册、初始化一次，但运行 Hook 按数组位置执行。插件应明确重复位置的语义：追踪可以在不同位置重复记录，接纳等一次性操作可按 Outcome 去重；不支持重复位置的插件自行拒绝。共享到新 Agent 时，会参与新 Agent 的注册与初始化。
- 组合插件可以在 `onRegister` 中插入普通内部插件，但最终数组仍是唯一执行顺序。
- Core 默认工具循环使用同一 Registry。插件也可以通过 `ctx.tools.get(name)` 或 `ctx.tools.values()` 读取原 Tool 对象，自行编排方法调用。

### 读取与直接复用工具

`get(name)` 返回注册时的原 Tool，不存在时返回 undefined。`values()` 返回有序数组快照，元素仍是原对象引用；修改该数组不改变 Registry。

```ts
const tool = ctx.tools.get('save')
if (tool) {
    const result = await tool.execute(callerInput, ctx)
}
```

使用者决定调用哪个方法、传什么参数、是否及如何调用 prepare。读取接口不包装 handler、不校验参数、不强制调用顺序。直接调用不自动经过 beforeTool/afterTool，不产生 Core 工具事件，也不建立 Run；需要这些能力时由调用插件按自己的合同编排。

注册时仍绑定 prepare/execute 方法并复制 policy。替换原对象的方法会影响直接调用，但不替换默认 Core 链已经保存的绑定；绑定方法内部读取的可变对象状态仍然共享。

## 推荐组合与协作原则

CTX 与 Hook 工作数据保持开放、可变。第三方插件可以设计自己的协作方式；官方推荐组合应把以下关系明确下来，降低装配方的记忆负担：

- **能力接口**：声明消费和发布什么能力、由谁拥有状态。可以使用构造参数中的对象引用或公开 CTX 扩展；例如 Steering 调用 Conversation.appendUserMessages，消息保存仍由 Session 负责。
- **对象配对**：把真实引用配对集中到已有组合对象。ChatConversationPlugin 会核对 Model 是否绑定同一个 Session；只注册该组合对象，不同时注册它内部的 Session/Model。
- **顺序**：说明各 Hook 读取、改写和记录数据的位置。候选数组是调用方选择，组合对象只组织自己承诺的关系；`after` 元数据不会让 Core 自动排序。
- **生命周期**：分别说明对象共享、重复位置、每次 Outcome 的接纳/释放、新 Agent 的再初始化，以及 Host 拥有的资源释放。
- **验证**：链接对应 owner SPEC 和真实 Core 组合测试；声明实际支持的场景，不把单插件通过测试当成任意组合兼容。

具体用法与装配顺序由各 owner 的包内文档和组合测试维护，入口见[独立包文档](../../README.zh-CN.md#包)。一个插件在不同 Hook 上可能需要不同相对位置；按声明的完整组合判断。

## 常见踩坑点

| 容易误解 | 实际行为与处理方式 |
|---|---|
| 改写工具结果后，所有记录都会同步改变 | Session 与 publish 出口各自看到所在 Hook 位置的版本；已经保存的字符串不会被后续改写追溯更新。需要保存改写版本时，把转换放在记录者之前。 |
| 多个 model 会自动连成中间件 | 最后一个 model 生效；包装插件显式委托上游。Events 必须是最后一个 model，前面仍需真实生成实现。 |
| 控制 Hook 的 yield 是即时通知 | 普通控制链先缓存事件；stop/result 会短路后项，afterTool 则完成所有整理处理器。即时 publish 和 Core stream 的交付时机分别验证。 |
| onRunEnd 执行过就表示全链收尾成功 | 后面的收尾仍可失败。发布出口不保证落盘；Host 的最终判断使用完整消费后返回的 Outcome。插件内部交接遵守自己的收尾顺序。 |
| CTX 不变，所以可用它区分每次 Run | CTX 区分 Agent，Outcome 区分调用。未被某插件接纳的调用也可能经过其 onRunEnd，释放前核对所属 Outcome。 |
| 对象可以共享，所以都可以并发共享 | Teams 为共享设计；Session、Events 等有自己的接纳限制。默认按各实例合同选择共享或独立创建。 |
| 新 Agent 复用插件对象，所以不需要初始化 | 新 CTX、工具表、注册和初始化重新建立。对象私有状态可保留，CTX 字段和外部 Agent 引用需要 owner 显式处理。 |
| 复制最终 ctx.plugins 就能直接重组 | onRegister 可能插入辅助对象，例如 Steering 尾对象；owner 需要归一化或重新构造候选，删除插件也不自动释放外部资源。 |
| Outcome.ok 表示业务已完成 | 它表示执行链无未恢复异常。工具错误回执、模型终态和团队目标各有含义；业务结束由其 owner 判断。 |
| 注册表固定，所以注册后的工具对象修改一定无效或一定生效 | prepare/execute 在注册时绑定；替换对象方法不会更新绑定。已绑定方法内部读取的可变状态仍可变化，由工具定义其语义。 |

例如，在 afterTool 中执行 `Session 保存 A → 后置插件改为 B`，会话保存 A，Core 最后交出的工作结果可以是 B。想让两者都看到 B，应选择 `改写为 B → Session 保存 → Events 观察` 的对应顺序；若需要同时保留原始和改写版本，则由具体插件明确各自用途。Core 不替组合方选择保存策略。

## 文档与验证

每个官方插件包至少包含：

```text
AGENTS.md                    本 scope 的路由、局部约束和精确验证命令
docs/specs/architecture.md   职责、状态、顺序、失败、组合和验收合同
README / guide / example     必要的人类使用入口
test/                        真实 Core 组合测试
```

行为变化先更新 SPEC，再补能在旧实现上失败的回归测试。验证类型、单元/组合测试和构建；真实网络、数据库、微信 Runtime 与 UI 验收分别报告。

对每个支持的组合验证共享数据改写、接纳和收尾归属、异常传播及重试边界。结合包的 API 说明不支持的组合。

当前框架在 1.0 前保持实验性。新增公共 API 应保持最小，并说明迁移边界；不要为未知未来协议增加包装层或兼容门面。

## 包内使用文档

配置与 API 从[独立包文档](../../README.zh-CN.md#包)进入。代码执行属于 [Code Mode 指南](../../packages/agent-plugin-code-mode/README.zh-CN.md)；新 Agent 引用交接和 Host runtime 用法属于 [Composition 指南](../../packages/agent-plugin-composition/README.zh-CN.md)。组合示例链接参与方，不成为多个包共同的权威正文。
