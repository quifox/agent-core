# @quifox/agent-plugin-teams

English | [简体中文](README.zh-CN.md)

Peer communication for ordinary Agents. Share one TeamsPlugin; each member retains its own Conversation, model, prompts, Tools, and ordinary run/stream interface.

The caller chooses the member count by registering members before execution; the plugin has no fixed team size.

```ts
import { createAgent } from '@quifox/agent-core'
import { TeamsPlugin } from '@quifox/agent-plugin-teams'
import { createSystemPromptPlugin } from '@quifox/agent-plugin-system-prompt'

// conversationA / conversationB 是各自已经构造的会话与模型组合。
const teams = new TeamsPlugin()
const promptA = createSystemPromptPlugin(conversationA, 'Research the task and send findings to B when needed.')
const promptB = createSystemPromptPlugin(conversationB, 'Verify findings and send the result to the requester.')
const a = createAgent({ plugins: [conversationA, promptA, teams] })
const b = createAgent({ plugins: [conversationB, promptB, teams] })
teams.register('A', a, conversationA)
teams.register('B', b, conversationB)

await b.run({ prompt: 'Work with A on an ocean research report.' })
// A also exposes the ordinary run/stream interface; there is no fixed leader.
```

team_receive waits up to ten seconds by default; timeoutMs: 0 checks immediately. Sending returns a delivery receipt, not proof that another member completed its task. One member's Outcome is not a global team-completion signal.

Teams is the final owner of asynchronous cleanup state. Explicit compatible coordination tails may follow it according to the specification. Mailbox checks are scheduled for a later event turn; Teams does not rewrite Core or model output.

New messages can wake an idle member after natural completion. One unread batch does not cause unbounded repeated runs. Stops, early stream closure, and failures do not immediately retry; unread messages remain available. Register members before the first call and inspect getStatus(name) when needed.

## Mailbox observations

```ts
const unsubscribe = teams.subscribe(event => {
    // message-posted: delivered; message-received: claimed.
    mailboxOutput.publish(event)
})
// When notifications are no longer needed: unsubscribe().
```

subscribe does not consume mail. Notification objects retain shared mutable identity; notificationError exposes sink failure. The Host encodes SSE or other transports. The [Teams Web example](../../examples/teams-web/README.md) provides a separate application surface.

See the [contract](docs/specs/architecture.md), [design and timing](docs/specs/design.md), and [research-team example](examples/research-team.ts).
