# AGENTS.md

Scope: packages/agent-plugin-checkpoint/。先读根 AGENTS.md 与 docs/specs/architecture.md。

- 只保存当前模型轮的执行记录；跨轮历史和请求属于会话组合。未知副作用不可自动重放。
- 按自身接纳的 Outcome 识别收尾归属；前置拒绝或合批调用不能清理当前执行者的状态。
- `started` 由 `beforeTool` 暂记，不代表工具已真实进入：正常 stop 且没有回执时 `onRunEnd` 必须回滚到进入前状态；prepare/execute 抛错且没有回执时保留 `started`，表示结果未知。恢复时只有这种未知调用才查询最终工具的 `retrySafe`；允许重试只是让 Core 重新进入原工具入口，不是后台自动重试。
- 标准组合把 Checkpoint 放在路由、权限、Interrupt 等控制型 `beforeTool` 之后，再放只观察且不改变决策的插件；这样 `started` 紧邻真实工具入口。实现仍须保留正常 stop 的暂记回滚，不依赖调用方偶然排序保证安全。
- 四空格、英文 JSDoc、strict ES2022 ESM；无隐式网络/文件 I/O。
- 验证 `pnpm --filter @quifox/agent-plugin-checkpoint check` 与 Session / Compaction 恢复组合测试。
