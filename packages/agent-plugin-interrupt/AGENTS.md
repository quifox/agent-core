# AGENTS.md

Scope: `packages/agent-plugin-interrupt/`。先读根 AGENTS.md 和 `docs/specs/architecture.md`。

- 用户主动中断策略属于本包；Core 负责执行事实、调用身份、结果提交与生命周期收口。
- 插件必须支持两种显式模式：`pause` 在安全边界停止并保留未完成调用供 Checkpoint 续跑；`terminate` 保留已执行工具的真实回执，为其余未执行调用逐个产生 `USER_INTERRUPTED` 结果并经过 `afterTool`，最后在 `afterStep` 停止。默认使用 `pause`，不得伪造已经开始工具的结果。
- 仅依赖 Core 公共 Hook/Plugin 合同。ES2022 ESM、strict TypeScript、四空格、英文 JSDoc；不依赖 Node、隐式网络或微信 API。
- 修改行为先更新 SPEC；验证 `pnpm --filter @quifox/agent-plugin-interrupt check`、Core check 与相关 Host 测试。
