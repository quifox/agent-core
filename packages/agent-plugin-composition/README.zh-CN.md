# @quifox/agent-plugin-composition

[English](README.md) | 简体中文

Agent Core 研究项目中的实验性新 Agent 重组能力，合同见[本包 SPEC](docs/specs/architecture.md)。

PluginCompositionPlugin 暂存完整有序的真实插件数组，在当前调用的最终收尾中创建新 Agent，并调用 Host 的 replaceAgent 回调。当前 CTX、Hook 和工具表保持在原 Agent 上。

Host 持有可替换的 Agent 引用并提供 replaceAgent。搭配 Code Mode 时才提供该包的代码执行器；Composition 本身不需要执行器或手动 apply/commit。

### 使用者的 runtime

使用者自己持有引用，`runtime = { agent }` 就足够；闭包或应用已有的类也可以。runtime 管当前 Agent 引用，execute 管源码执行，是 Host 的两个不同职责。

直接调用 `runtime.agent.run(input)` / `runtime.agent.stream(input)` 即可。只有应用需要一个固定的 run/stream 调用对象时，才增加下面这种薄转发。这是 Host 本地示例：

```ts
import type { Agent } from '@quifox/agent-core'

function createHostApi<Input>(runtime: { agent: Agent<Input> }) {
    return {
        run(input: Input) { return runtime.agent.run(input) },
        stream(input: Input) { return runtime.agent.stream(input) },
    }
}
```

每次方法调用都重新读取 runtime.agent。若初始化时直接返回旧 Agent 对象，或缓存绑定到旧 Agent 的方法，调用者仍然使用旧对象。已经开始的 run，以及已经从旧 Agent 取得的 stream 生成器，也保持原执行；替换引用不会将它们转移到新 Agent。

### Host 装配

这是应用 Host 代码：

```ts
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { PluginCompositionPlugin } from '@quifox/agent-plugin-composition'

function createCompositionHost<Input>(initialPlugins: AgentPlugin<Input>[]) {
    const composition = new PluginCompositionPlugin<Input>({
        replaceAgent: nextAgent => { runtime.agent = nextAgent },
    })
    const runtime = {
        agent: createAgent({ plugins: [...initialPlugins, composition] }),
    }
    return {
        runtime,
        setNextPlugins: (plugins: AgentPlugin<Input>[]) =>
            composition.setNextPlugins(plugins),
    }
}
```

在管理插件已进入 onRunStart 后，从运行 Hook 调用返回的 setNextPlugins 能力。Composition 可以单独使用；需要执行模型提供的代码时，再加入 [Code Mode](../agent-plugin-code-mode/README.zh-CN.md)，通过 bindings 注入回调。[已纳入类型检查的组合 Host 示例](../agent-plugin-code-mode/test/host-example.ts) 展示具体接线。

### 模型提交的代码

已安装 Code Mode 和 Host 绑定时，以下 JS 可以构造普通插件对象。代码执行与变量绑定遵守该包合同：

```js
const newPlugin = {
    id: 'generated-note',
    hooks: {
        onRunStart: async ctx => {
            ctx.generatedNote = '通过代码加入的新能力';
            return { action: 'continue' };
        },
    },
};

setNextPlugins([...ctx.plugins, newPlugin]);
return '下一个 Agent 将包含 generated-note';
```

删除和排序使用普通数组操作，例如：

```js
setNextPlugins(ctx.plugins.filter(plugin => plugin.id !== 'generated-note'));
```

每次提交完整有序数组，最后一次成功提交覆盖之前提案。允许空列表、自移除、重复 ID 和重复对象位置；ID 不代表唯一对象身份。管理插件只从提案中移除自己的内部收尾对象，其他注册辅助对象、依赖与对象复用仍由各 owner 负责。

setNextPlugins 暂存给最近一个已进入管理插件 onRunStart、尚未最终收尾的运行。没有这样的运行时调用会抛错，因此不能在空闲时把它当成普通配置 setter；可以在已进入该管理插件的运行 Hook 或 execute_code 中提交。提交不会让本轮的新工具立即可用。

想保留后续代码执行或热更新能力，完整数组里需要继续保留相应的 Code Mode / Composition 对象；遗漏就会移除，框架不自动补回。复制 ctx.plugins 后新增对象适用于这些对象的复用合同都允许的情况；其他 owner 的辅助对象仍需按其合同处理。

### 收尾与引用语义

管理插件在 onRegister 中插入一个私有收尾对象，在初始化和替换前核对其拥有最后一个 onRunEnd。此前收尾全部完成后，成功 Outcome 与提案才触发创建和替换；执行或前序收尾失败会丢弃提案。

这是最后的业务收尾边界，不表示旧 run Promise 已经返回。旧 Agent 继续完成原执行和最终事件；新能力在新 Agent 首次调用时注册、初始化。替换回调抛错会形成收尾失败，回调产生的外部部分效果不自动回滚。

每次调用读取 runtime.agent；缓存的旧 Agent 引用不会改变。新 Agent 使用新 CTX。符合复用合同的 Session 对象可以保留自身历史，CTX 字段与外部 Agent 引用不自动迁移。

引用替换成功只表示新 Agent 已构造。新数组的 onRegister/onInitialize 要到首次执行才运行，因此本轮 Outcome.ok 不能证明下一轮的组合有效；新组合若缺少进入模型阶段所需的能力，仍在下一轮失败。Host 持有的 Teams 成员映射、订阅和资源绑定，按对应 owner 合同更新或释放。

新 Agent 首次执行失败时，Host 引用仍是刚交接的新对象。后续如何重新构造组合或再次调整引用由 Host 处理，Composition 不自动恢复旧 Agent 或回滚其他 owner 的初始化效果。

Composition 与 Code Mode 不拒绝并发 run。需要协调物理执行时，由独立接纳插件负责；无 Context 参数的 setNextPlugins 绑定定位最近一个已进入管理插件的运行，不承诺并发提案自动排程。

Steering 等同样要求最终收尾位置的插件，需要明确的兼容组合合同。Composition 不重排其他对象，不保证任意组合兼容。

完整边界见 [Composition SPEC](docs/specs/architecture.md) 与 [真实 Core 测试](test/plugin.test.ts)。
