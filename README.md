# Agent Core

English | [简体中文](README.zh-CN.md)

> **Experimental research project.** A small execution kernel for exploring agents assembled from explicit plugins. APIs and composition contracts are evolving; production readiness has not been established.

<p align="center">
  <strong>An open hook system for composing your own agent behavior.</strong>
</p>

Agent Core provides a default execution loop and Hooks across its lifecycle. Plugins add model generation, sessions, prompts, Tools, interruption, recovery, compaction, events, child tasks, and teams.

Mutable Context and Hook data give plugin authors room to experiment. Coordination between plugins depends on their shared capabilities, ordering, and lifecycle contracts.

## Design demo

A visual tour of lifecycle Hooks, sessions, interruption and recovery, plugin composition, tracing, Code Mode, and peer-Agent collaboration, followed by application examples.

[![Agent Core lifecycle Hooks and plugin composition](docs/media/agent-core-demo.png)](docs/media/agent-core-demo.mp4)

[Watch the Agent Core and plugin capabilities demo](docs/media/agent-core-demo.mp4).

## Explore plugin composition

- Keep conversation history with Chat or Responses sessions.
- Combine interruption, checkpoints, and new input during execution.
- Share a Teams plugin among ordinary peer Agents.
- Execute Host-provided code and recompose plugin sets.

## Try from source

With Node.js 22+ and pnpm, install and build the workspace from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
```

### DeepSeek Chat example

A Node.js 22+ Host can compose Chat history and model generation as one conversation plugin. This example uses the DeepSeek `deepseek-flash` model through Chat Completions ([official model documentation](https://api-docs.deepseek.com/quick_start/pricing/)).

This is one example of plugin composition. You can implement and combine plugins to create richer capabilities and different agent behaviors.

Run the following JavaScript from the repository root. The Host supplies `DEEPSEEK_API_KEY` through its environment.

```js
import { createAgent } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, ChatConversationPlugin } from '@quifox/agent-plugin-session'

const session = new ChatSessionPlugin({ id: 'example', ownerId: 'example' })
const generation = new ChatModelPlugin({
    session,
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    assistantReasoningField: 'reasoning_content'
})
const conversation = new ChatConversationPlugin({ session, generation })
const agent = createAgent({ plugins: [conversation] })
const outcome = await agent.run({ prompt: 'Reply with exactly "Hello World".' })
if (!outcome.ok) { throw outcome.error }
console.log(conversation.readOutput())
```

## Packages

| Package | Responsibility |
| --- | --- |
| [agent-core](packages/agent-core/README.md) | Default loop, Hooks, Context, Outcome, and Tool contracts |
| [agent-plugin-model](packages/agent-plugin-model/README.md) | Model generation Hooks and internal protocol/transport adapters |
| [agent-plugin-session](packages/agent-plugin-session/README.md) | Chat history, storage, fork, and Conversation composition |
| [agent-plugin-compaction](packages/agent-plugin-compaction/README.md) | Context budgets, summaries, and checkpoints |
| [agent-plugin-checkpoint](packages/agent-plugin-checkpoint/README.md) | Current-turn execution records and recovery data |
| [agent-plugin-interrupt](packages/agent-plugin-interrupt/README.md) | Cooperative pause and terminate policies |
| [agent-plugin-steering](packages/agent-plugin-steering/README.md) | Input batching and run handoff |
| [agent-plugin-code-mode](packages/agent-plugin-code-mode/README.md) | Host code execution and asynchronous Tool proxies |
| [agent-plugin-composition](packages/agent-plugin-composition/README.md) | Plugin-array proposals and next-Agent reference handoff |
| [agent-plugin-tools](packages/agent-plugin-tools/README.md) | Tool catalog, visibility, and entry routing |
| [agent-plugin-system-prompt](packages/agent-plugin-system-prompt/README.md) | Caller-provided trusted prompt contributions |
| [agent-plugin-subagents](packages/agent-plugin-subagents/README.md) | In-process child tasks and waiting |
| [agent-plugin-teams](packages/agent-plugin-teams/README.md) | Peer mailboxes and member wake-up scheduling |
| [agent-plugin-events](packages/agent-plugin-events/README.md) | Per-Agent execution observations |
| [agent-plugin-formal-backend](packages/agent-plugin-formal-backend/README.md) | Reference Responses backend composition |

## Examples and further reading

- [Teams workbench](examples/teams-web/README.md): peer-Agent collaboration, independent event streams, and mailbox delivery.
- [Plugin authoring guide](docs/guides/plugin-authoring.md).
- [Architecture guide](docs/guides/architecture.md).
- [Roadmap](ROADMAP.md).

## Related projects

Agent Core assembles capabilities through lifecycle hooks around a minimal execution kernel. [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) likewise explores composable, plugin-based agent systems, with its plugin architecture built on Cordis.
