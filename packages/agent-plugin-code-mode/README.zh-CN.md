# @quifox/agent-plugin-code-mode

[English](README.md) | 简体中文

实验性的宿主代码执行能力，提供真实 Agent Context 与异步 Tool 代理。执行器由应用提供；本包可独立于 Composition 使用。

## Host 装配

这个本地 Host 函数将 Code Mode 加到调用方已有的 Model/Session/Tool 组合中：

```ts
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { CodeModePlugin, type CodeModeOptions } from '@quifox/agent-plugin-code-mode'

function createCodeHost<Input>(
    initialPlugins: AgentPlugin<Input>[],
    execute: CodeModeOptions['execute'],
) {
    const codeMode = new CodeModePlugin<Input>({ execute })
    return createAgent({ plugins: [...initialPlugins, codeMode] })
}
```

执行器接收代码和 environment，其中包含 ctx、tools 及 Host 绑定。源码求值、JS/TS 编译、import、隔离、权限和计算限制归执行器。真实 Context 对象与函数需要同进程执行器或明确桥接，仅传 JSON 无法传递这些能力。以下代码使用裸变量时，执行器需要把 environment 中的项绑定为源码变量。

可选的 bindings(ctx) 提供应用函数。Code Mode 在这些绑定之后提供 ctx/tools，它们仍是实际 Context 和代理。

## 代码与工具调用

CodeModePlugin 注册普通工具 execute_code({ code })。执行时通过同一 Registry 的 definitions/get 读取真实工具，以注册名称生成异步代理。下面假设应用已注册名为 process_item 的工具，items 由 Host 提供：

```js
const receipts = [];
for (const item of items) {
    receipts.push(await tools.process_item(item));
}
return receipts.map(receipt => receipt.content);
```

工具名来自注册表，不从插件 ID 猜测；非 JS 标识符用 tools['a-name']。代理串行执行，包括 Promise.all 发起的调用。Code Mode 调度既有 beforeTool，调用目标原 Tool 的 prepare/execute，再调度完整 afterTool；改写目标、结果覆盖、stop 和异常仍归实际 Hook/Tool 决定。

子调用 ID 与外层 execute_code 关联，避开当前模型轮的原生调用 ID。子 Hook 事件和回执缓存到外层 afterTool/onError 边界后交付；它们是 Code Mode 的观察事件，不是第二次 Core Run 或即时嵌套流。Session 保存外层代码回执；代码应返回可供模型使用的摘要，不期待未匹配的子回执自动进入历史。

Hook stop 阻止后续代理调用，在外层回执中报告 CODE_STOPPED，再通过外层 afterTool 传回停止决定。代码内部捕获的 Tool/Hook 异常由代码处理；向外传播的异常进入 Core 既有错误与收尾流程。

ctx.tools.get(name) 取得的原方法仍可自由调用，不自动经过代理、不自动触发 Hook 或事件，也不强制先调用 prepare。代理只是一种调用方选择的编排。

生成插件的 Hook 使用该 Hook 收到的 CTX，不保留过去代码执行的 tools 代理；执行结束后代理失效。正在被代理调度的 Tool/Hook 不应等待同一个串行代理队列，应调用当前 CTX 的原 Tool 方法或自己的服务，避免自等待。

合同与证据见 [Code Mode SPEC](docs/specs/architecture.md)、[组合测试](test/plugin.test.ts)、[已纳入类型检查的 Host 示例](test/host-example.ts)。

## 可选插件重组

需要切换下一组插件时，使用独立的 [Composition 包](../agent-plugin-composition/README.zh-CN.md)。Host 通过 bindings 注入 setNextPlugins 回调；它不是 Code Mode 的内置绑定。runtime 引用与替换失败归 Composition/Host，接线见[组合 Host 示例](test/host-example.ts)。
