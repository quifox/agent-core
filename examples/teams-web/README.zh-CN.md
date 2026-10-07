# 团队工作台

[English](README.md) | 简体中文

本地研究演示使用四个平级普通 Agent，各自组合 Chat、生成、提示词、Steering、Events，共享一个 TeamsPlugin。任意成员可接收输入，四路成员 SSE 与独立邮箱出口展示执行/投递事实。

四名成员是这个工作台的演示配置；TeamsPlugin 没有固定的成员数量。

## 运行

使用 workspace 固定的 Node/pnpm。服务端配置 MODEL_API_KEY、MODEL_BASE_URL 和 MODEL_ID；凭证不进入浏览器。

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/teams-web/dist/server.js
```

打开 http://127.0.0.1:18731/，TEAMS_PORT 可改端口。向任意成员提交，追加消息仍通过该 Agent 原 run 与 Steering 接纳。团队跨调用持续存在。

默认任务使用明确模拟的资料/成本卡；模型文本与工具调用来自配置的模型插件。展示框架协作，不宣称联网研究或真实问卷。页面没有角色正则最终报告或全队完成信号。

## 观察

UI 只观察 Events/Teams，不调用 team_receive。投递/领取时间是 Host 展示投影，领取不表示完成。SSE 关闭不停止运行，缓存补发是展示恢复而不是模型恢复。

这是 loopback 内存演示，不是多用户部署/宕机恢复方案，见[应用合同](docs/specs/architecture.md)和 [Teams 包](../../packages/agent-plugin-teams/README.zh-CN.md)。
