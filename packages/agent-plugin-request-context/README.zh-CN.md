# 请求上下文插件

`@quifox/agent-plugin-request-context` 把其他插件提供的短期上下文加入 Chat 模型请求，同时保持 Session 的原始历史不变。它组合现有 Chat Model 和 Session 插件，不修改这两个插件或 Core。

## 用法

为 Session 创建 `RequestContextPlugin`，让 `ChatModelPlugin` 使用 `context.source`，再注册组合会话和贡献上下文的插件：

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

上下文作为临时 system message 进入模型请求。Session 会先接纳并保存原始消息，再生成请求投影。每次 `beforeModel` 都调用 `set`；重试时重新计算上下文，不随 pending input 冻结。

Chat 压缩的预算估算应使用对应 RequestContext 的投影：

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

`fork` 和 `empty` 会创建新的 RequestContext，并让生成插件绑定到新 source；不会复制父级贡献。不要把同一个 RequestContext 再单独注册，因为 `ContextualChatConversationPlugin` 已合并它的 hooks。
