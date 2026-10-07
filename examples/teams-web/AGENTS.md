# AGENTS.md

Scope: examples/teams-web/。先读根 AGENTS.md 和 docs/specs/architecture.md。

- 本地 Node 服务端与独立 Web 展示；一个 Host 持有四个真实 Agent，成员事件出口独立，中心邮箱订阅共享 Teams。
- 不修改 Core，不用小程序 Host 或本地 model gateway。真实密钥只从服务端环境读取，不送前端或记录进事件。
- 给定资料明确为演示数据；真实模型任务必须通过普通消息工具协作，不伪造成功输出。
- Node I/O、HTTP/SSE 和展示记录留在本例；UI 只消费事件，不调用 team_receive。严格 TS，无新增第三方运行库。
- 验证 typecheck、局部测试、编译产物、真实 API 与浏览器视觉结果；不跑无关全仓门禁。
