# @quifox/agent-plugin-code-mode

English | [简体中文](README.zh-CN.md)

Experimental Host-executed code with the real Agent Context and asynchronous Tool proxies. The code executor is supplied by the application; this package works without Composition.

## Host setup

This local Host function adds Code Mode to the caller's existing Model/Session/Tool composition:

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

The executor receives code and an environment containing ctx, tools, and any Host bindings. It owns source evaluation, JS/TS compilation, imports, isolation, permissions, and computation limits. A same-realm executor or explicit bridge is needed for real Context objects and functions; JSON transfer alone does not transport them. For the bare-name code below, the executor must bind environment entries as source variables.

Optional bindings(ctx) can publish application helpers. ctx/tools are supplied by Code Mode after those bindings and remain the actual Context and proxies.

## Code and Tool calls

`CodeModePlugin` registers `execute_code({ code })` as a normal Tool. At execution it scans the same Registry's public definitions/get interfaces and creates asynchronous proxies using exact registered Tool names. This example assumes an application Tool named `process_item` and Host-provided `items`:

```js
const receipts = [];
for (const item of items) {
    receipts.push(await tools.process_item(item));
}
return receipts.map(receipt => receipt.content);
```

Names are not guessed from plugin IDs; use `tools['a-name']` where a name is not a JS identifier. Proxy requests run serially, including Promise.all callers. Code Mode dispatches the existing beforeTool Hooks, invokes the selected original Tool's prepare/execute, and dispatches every afterTool Hook. Result overrides, target rewrites, stop decisions, and errors remain plugin/Tool-owned.

Child calls have distinct IDs derived from the outer execute_code call and avoid the current model turn's native call IDs. Their Hook events and Tool receipts are buffered until the outer afterTool/onError boundary. They are Code Mode observations, not a second Core Run or a promise of live nested Core streaming. The Session receives the outer code receipt; return a useful summary from the code instead of expecting unmatched child receipts to enter model history.

A Hook stop prevents further proxy calls, reports CODE_STOPPED in the outer Tool receipt, and relays the stop decision back through the outer afterTool. Tool/Hook exceptions caught by the code remain handled there; escaping exceptions follow the existing Core error/cleanup path.

Direct `ctx.tools.get(name).prepare/execute` calls stay ordinary method calls. They do not automatically pass through proxies, produce Core Hook events, or impose a call sequence. The Code Mode proxy is one caller's chosen orchestration of those methods.

Generated plugin Hooks use the CTX passed to that Hook. Do not capture a past code execution's `tools` proxies: those expire when execution closes. Tool implementations and Hooks also must not await the same serial proxy queue from inside its dispatch; use raw current-CTX Tool methods or their own service instead.

See the [Code Mode contract](docs/specs/architecture.md), [integration tests](test/plugin.test.ts), and [typechecked Host example](test/host-example.ts).

## Optional recomposition

For next-Agent plugin changes, use the separate [Composition package](../agent-plugin-composition/README.md). The Host injects its setNextPlugins callback through bindings; it is not a built-in Code Mode binding. Runtime reference ownership and replacement failure belong to Composition/Host. See the [combined Host example](test/host-example.ts).
