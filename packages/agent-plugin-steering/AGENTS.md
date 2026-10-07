# AGENTS.md

Scope: `packages/agent-plugin-steering/`。先读根 AGENTS.md 与 `docs/specs/architecture.md`。

- 本包接纳同一 Agent 的并发 `run({ prompt })`，将输入按模型请求边界合批；只允许一个物理运行进入后续有状态插件。
- 队首就是当前物理运行，不维护独立 active 布尔值。消息历史由 Conversation 唯一持有；本包只暂存尚未接纳的输入命令及等待调用。
- 内部组合 `InterruptPlugin` 的 terminate 策略：当前已进入的工具等待真实回执，余下调用取得停止回执并闭合；不恢复旧工具，不引入 Abort。
- 本插件必须放在插件数组首位。ES2022 ESM、strict TypeScript、四空格、英文 JSDoc；无 Node、隐式网络或文件 I/O。
- 验证 `pnpm --filter @quifox/agent-plugin-steering check`、Session/Interrupt/Checkpoint/Event 组合和架构边界；时序测试使用真实 Core。
