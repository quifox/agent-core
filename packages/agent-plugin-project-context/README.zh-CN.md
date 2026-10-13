# 项目上下文插件

[English](README.md) | 简体中文

SkillsPlugin 发现标准 Agent Skills 元数据，并提供 skill_list、skill_load、skill_read。ProjectGuidancePlugin 加载祖先作用域中的 AGENTS.md，同级非空 AGENTS.override.md 优先。两者通过相同临时上下文 writer 贡献内容。

```ts
const skills = new SkillsPlugin({ files, roots: ['project-skills'], context: () => context })
const guidance = new ProjectGuidancePlugin({ files, scopes: ['global', 'project', 'current'], context: () => context })
const agent = createAgent({ plugins: [contextualConversation, guidance, skills] })
```

Host 提供受根目录约束的 files：目录枚举、仅元数据读取与完整读取，并验证符号链接的真实路径。context 为匹配的 RequestContextPlugin writer。初始只加载目录；正文按需加载，也可通过 selected(input, ctx) 接纳用户明确选择的技能。资源限制在技能目录中，脚本经普通 Host 工具及其 policy 执行。

见 [合同](docs/specs/architecture.md)、[请求上下文](../agent-plugin-request-context/README.zh-CN.md) 与 [Agent Skills 格式](https://agentskills.io/specification)。
