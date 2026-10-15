# 项目上下文插件

[English](README.md) | 简体中文

SkillsPlugin 发现标准 Agent Skills 元数据，仅提供 skill_list 重新扫描。目录包含可读取的 SKILL.md 路径，Agent 通过已有文件或命令能力读取正文与相对引用。ProjectGuidancePlugin 加载祖先作用域中的 AGENTS.md，同级非空 AGENTS.override.md 优先。两者通过相同临时上下文 writer 提供简短说明。

```ts
const skills = new SkillsPlugin({ files, roots: ['project-skills'], context: () => context })
const guidance = new ProjectGuidancePlugin({ files, scopes: ['global', 'project', 'current'], context: () => context })
const agent = createAgent({ plugins: [contextualConversation, guidance, skills] })
```

Host 提供受根目录约束的 files：目录枚举、仅元数据读取、完整读取及 sourcePath(root, path)，并验证符号链接的真实路径；插件打包资源须落在所报告的可读取位置。context 为匹配的 RequestContextPlugin writer。初始只加载元数据；selected(input, ctx) 可把用户明确选择的技能投影到当前请求。脚本经普通 Host 工具及其 policy 执行。

见 [合同](docs/specs/architecture.md)、[请求上下文](../agent-plugin-request-context/README.zh-CN.md) 与 [Agent Skills 格式](https://agentskills.io/specification)。
