# AGENTS.md

Scope: packages/agent-plugin-project-context。继承根规则，读 [模块 SPEC](docs/specs/architecture.md)。

- 本包只发现标准 Skills 与作用域指引并贡献请求上下文；Host 提供受根目录约束的文件能力。
- 技能目录只读取 YAML metadata；正文与资源按需读取。脚本不隐式执行或获得额外授权。
- 路径使用根标识与相对引用；Host 校验真实路径和符号链接，插件拒绝绝对路径、穿越和非法引用。
- 验证 `bun run --filter @quifox/agent-plugin-project-context check` 及 shared-runtime 的真实文件组合测试。
