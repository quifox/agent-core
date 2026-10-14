# Request Context Plugin

`@quifox/agent-plugin-request-context` composes short-lived plugin context into Chat model requests while keeping the canonical Session history unchanged. It works with the existing Chat Model and Session plugins; it does not modify either package or the Core loop.

## Usage

Create a `RequestContextPlugin` for the Session, bind `ChatModelPlugin` to `context.source`, and register the contextual Conversation followed by plugins that contribute request context:

```ts
const session = new ChatSessionPlugin({ id: 'chat-1', ownerId: 'user-1' })
const context = new RequestContextPlugin(session)
const generation = new ChatModelPlugin({ session: context.source, ...modelOptions })
const conversation = new ContextualChatConversationPlugin({ session, generation, context })

const memory = {
    id: 'memory',
    hooks: {
        beforeModel: async () => {
            context.set('memory', currentMemory)
            return { action: 'continue' }
        }
    }
}

const agent = createAgent({ plugins: [conversation, memory] })
```

The contribution is inserted as a temporary system message in the model request. Session accepts and persists the canonical messages before that projection is created. Use `set` again on each `beforeModel`; the projection is recalculated on retries and is not frozen with pending input.

For Chat compaction, pass a factory that uses the matching RequestContext projection in its estimator:

```ts
compaction: (session, generation, context) => new ChatCompactionSource(
    session,
    generation,
    request => estimateChatInputTokens({
        ...request,
        messages: context.project(request.messages)
    })
)
```

`fork` and `empty` create a new RequestContext and rebind generation to it. Parent contributions are not copied. Do not register the same RequestContext instance separately; its hooks are already included by `ContextualChatConversationPlugin`.
