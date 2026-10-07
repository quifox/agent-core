# @quifox/agent-plugin-teams

[English](README.md) | 简体中文

多个普通 Agent 共享一个 TeamsPlugin，使用 team_send 和 team_receive 通信。所有成员都保留原来的 run/stream 入口，各自组合会话、模型、身份提示词和工具。

成员数量由调用方在运行前注册决定；插件没有固定的团队人数。

```ts
import { createAgent } from '@quifox/agent-core'
import { TeamsPlugin } from '@quifox/agent-plugin-teams'
import { createSystemPromptPlugin } from '@quifox/agent-plugin-system-prompt'

// conversationA / conversationB 是各自已经构造的会话与模型组合。
const teams = new TeamsPlugin()
const promptA = createSystemPromptPlugin(conversationA, '你负责研究，必要时向 B 发送资料。')
const promptB = createSystemPromptPlugin(conversationB, '你负责核验，向请求方发送核验结果。')
const a = createAgent({ plugins: [conversationA, promptA, teams] })
const b = createAgent({ plugins: [conversationB, promptB, teams] })
teams.register('A', a, conversationA)
teams.register('B', b, conversationB)

await b.run({ prompt: '与 A 协作，完成一份海洋研究报告。' })
// a 也可以直接 run/stream；此处没有固定 Leader。
```

team_receive 默认等待十秒，timeoutMs=0 可立即检查。发送只返回投递回执，成员是否已经完成任务需要正常接收消息确认。某一成员 run 返回不代表全队后台工作全部结束。

Teams 必须是最后一个拥有异步收尾状态的插件；初始化会核验这个顺序。Steering 注册的同步协调尾对象显式声明位于 Teams 之后，用于等待完整收尾链。Teams 只安排后续事件回合的信箱检查，不包装 Agent 方法，也不修改模型结果或 Core 循环。

自然完成后有新消息可再次唤醒；同一批未读消息不会导致无限自动运行。主动停止、流提前关闭和失败不立即自动重试；尚未领取的消息保留，可用 getStatus(name) 查看状态。所有成员须在首次运行前登记。

中心邮箱由 Teams 自己发布观察通知，UI 不调用 team_receive：

```ts
const unsubscribe = teams.subscribe(event => {
    // message-posted：已投递；message-received：成员已领取。
    mailboxOutput.publish(event)
})
// 展示端不再需要时：unsubscribe()
```

subscribe 本身不读取信箱，通知对象保持默认的共享可变语义；出口异常可从 notificationError 查询。SSE 或其他传输由应用层接入并立即编码事件。独立服务端和四对话框展示见 [Teams Web](../../examples/teams-web/README.md)。

- [长期规范](docs/specs/architecture.md)
- [设计与事件时序](docs/specs/design.md)
- [不同模型、提示词与工具的研究团队示例](examples/research-team.ts)
