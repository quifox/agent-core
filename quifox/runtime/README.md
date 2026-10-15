# QuiFox shared runtime

[English](README.md) | [简体中文](README.zh-CN.md)

The internal workspace Host used by [TUI](../tui/README.md) and [Desktop](../desktop/README.md). It assembles the same Chat, Session, recovery, compaction, Memory, Skills, project guidance, permissions, MCP, background tasks and Subagents around the unchanged Core.

```ts
import { QuiFoxRuntime, type SessionView } from '@quifox/shared-runtime'

const runtime = await QuiFoxRuntime.open({ workspace: process.cwd() })
try {
    const session = await runtime.command({ type: 'create' }) as SessionView
    runtime.subscribe(event => console.log(event.type, event.sequence))
    await runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Explain this project.' })
    await runtime.waitForIdle(session.id)
} finally {
    await runtime.close()
}
```

The Host owns filesystem, processes and transports. `RuntimeCommand` exposes sessions, model selection, project files, approvals, configuration, MCP, Memory and shutdown. Events carry session, run and sequence identities; accepting a message or task does not mean it completed. The sidecar uses the same commands through JSONL on stdin/stdout. Optional UUID `create.sessionId` and stable `submit.messageId` allow acknowledgement retries without creating another session or input; conflicting payloads are rejected.

## Configuration and data

The default root is `~/.quifox`; `root` selects an independent data directory. It contains `config.json`, `models.json`, original session JSONL and owner-scoped Memory. Multiple Hosts may share a root and run different sessions; one Host owns execution of each session tree at a time. New UI launches open a fresh main conversation; history is selected explicitly. An idle Host refreshes shared configuration before its next command.

`MODEL_API_KEY`, `MODEL_BASE_URL` and `MODEL_ID` override the Chat connection in memory. They are not automatically saved. The default route is DeepSeek `deepseek-flash`; another model needs matching models.dev metadata or an explicit `model.contextWindow`. Refresh model metadata with `refresh-models` when idle.

Configuration accepts a default `model`, additional `models` with stable IDs, reasoning defaults/support lists, `compaction.context`, `compactTokens`, `safetyTokens`, Memory and `approval: "ask" | "allow"`. Budgets tighten known model capacities. Change configuration while runs and background tasks are idle; candidate composition finishes before configuration is committed. Optional capacity/compaction fields can be removed with `null` in a config patch. Public snapshots omit credentials and URL query parameters.

`model-catalog` reads the cached Models.dev Chat directory; `refresh: true` updates it without model credentials. The API's reasoning flag does not imply effort levels or a vendor default. `model.reasoningEfforts` explicitly declares supported levels; `preferences.reasoningEffort` defaults to `high` and applies only when supported. `reasoningEfforts: null` clears a manual declaration. A changed URL origin clears omitted connection credentials. `resources` reads directory metadata without creating a session, and `plugins` reports the actual composition.

Project `.quifox/config.json` files inherit from global configuration through every ancestor directory. A project cannot grant MCP trust, raise global `ask` authorization, or re-enable globally disabled Memory. A model destination must first be declared in the user's model list; changing URL origins does not inherit credentials or provider options. An independent `root` never imports the default user's configuration as a project layer.

Agent definitions use YAML frontmatter in `<root>/agents/*.md`, ancestor `.claude/agents/*.md` or `.quifox/agents/*.md`. Supported fields are `name`, `description`, `model`, `tools`, `disallowedTools`, `permissionMode`, and `effort`; closest names win. `permissionMode` supports `default`, `plan` and `dontAsk`; other modes are reported as unsupported. Children inherit or select a model and cannot exceed their parent's effective tool permissions.

MCP servers use standard stdio or HTTP transports:

```json
{
    "mcp": [
        { "id": "local", "transport": "stdio", "command": "your-mcp-server", "args": [] }
    ]
}
```

Skills use standard `.agents/skills/<name>/SKILL.md` and quifox skill roots; metadata is discovered first and bodies/resources are loaded on demand. Project guidance follows ancestor scopes and same-directory `AGENTS.override.md` precedence. File mutations, commands and MCP tools use the ordinary policy/approval path.

Project MCP connections require user authorization in settings. Untrusted or failed servers leave ordinary tools usable and show their actual state. Connect/retry while idle to rebuild the tool catalog; shutdown joins transport cleanup, including pending handshakes.

Memory reuses the existing two-stage plugin. It keeps the original archive separate from summaries and temporary request context. Background commands return a task ID; use `task_wait` to observe it immediately (`timeoutMs: 0`) or wait, and `task_cancel` to request cancellation. `subagent_start` defaults to empty history; explicit `mode: "fork"` copies the safe parent prefix. Without a prompt it creates an idle child; supplying a prompt starts asynchronously. QuiFox allows one child level and excludes creation tools from child requests. Wait results identify the actual task and keep the child's unmodified response in `text`. Recovered unknown work requires checking the child session. Native cancellation cannot establish that side effects were rolled back.

See the [Host contract](docs/specs/architecture.md) and [package ownership](../../docs/specs/packages.md).
