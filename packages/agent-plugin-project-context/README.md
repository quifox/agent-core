# Project Context Plugins

English | [简体中文](README.zh-CN.md)

`SkillsPlugin` discovers standard Agent Skills metadata, then exposes `skill_list`, `skill_load`, and `skill_read`. `ProjectGuidancePlugin` loads ancestor AGENTS.md files, giving a nonempty AGENTS.override.md priority at each scope. Both contribute through the same temporary context writer.

```ts
const skills = new SkillsPlugin({ files, roots: ['project-skills'], context: () => context })
const guidance = new ProjectGuidancePlugin({ files, scopes: ['global', 'project', 'current'], context: () => context })
const agent = createAgent({ plugins: [contextualConversation, guidance, skills] })
```

The Host supplies `files` with root-confined list, metadata-only read, and full read operations, including real-path checks for symlinks. `context` is the matching RequestContextPlugin writer. Only the catalog is loaded initially; activate instructions explicitly or use the optional `selected(input, ctx)` callback for a user-selected skill. Resources stay within that skill directory, and scripts run through ordinary Host tools and their approval policy.

See the [contract](docs/specs/architecture.md), [Request Context](../agent-plugin-request-context/README.md), and [Agent Skills format](https://agentskills.io/specification).
