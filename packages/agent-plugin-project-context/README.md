# Project Context Plugins

English | [简体中文](README.zh-CN.md)

`SkillsPlugin` discovers standard Agent Skills metadata and exposes `skill_list` to rescan it. Catalog entries include readable `SKILL.md` paths; Agents read instructions and relative references with their existing file or command tools. `ProjectGuidancePlugin` loads ancestor AGENTS.md files, giving a nonempty AGENTS.override.md priority at each scope. Both contribute short instructions through the same temporary context writer.

```ts
const skills = new SkillsPlugin({ files, roots: ['project-skills'], context: () => context })
const guidance = new ProjectGuidancePlugin({ files, scopes: ['global', 'project', 'current'], context: () => context })
const agent = createAgent({ plugins: [contextualConversation, guidance, skills] })
```

The Host supplies `files` with root-confined list, metadata-only read, full read and `sourcePath(root, path)` operations, including real-path checks for symlinks. Bundled resources must be available at the reported paths. `context` is the matching RequestContextPlugin writer. Only metadata is loaded initially; the optional `selected(input, ctx)` callback projects a user-selected skill into the current request. Scripts use ordinary Host tools and their approval policy.

See the [contract](docs/specs/architecture.md), [Request Context](../agent-plugin-request-context/README.md), and [Agent Skills format](https://agentskills.io/specification).
