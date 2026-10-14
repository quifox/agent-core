# QuiFox Desktop

[English](README.md) | [简体中文](README.zh-CN.md)

Tauri 2 + React with a compiled Bun sidecar. Workspaces, sessions, chat, approvals, Skills, Memory and expandable tool/subagent traces call the same [Host](../runtime/README.md) as the TUI. Rust owns the window and process bridge.

From the repository root, with Bun and the native [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) installed:

```sh
bun run --filter @quifox/desktop desktop:dev
bun run --filter @quifox/desktop desktop:build
```

The build creates the native engine for the Rust host target and generates application icons from the original blue/yellow fox SVG. On macOS it signs and verifies the completed sidecar; `APPLE_SIGNING_IDENTITY` can select a signing identity, otherwise the local build uses ad hoc signing. Distribution signing/notarization remains a separate release concern. See [Bun executable signing](https://bun.com/docs/bundler/executables#code-signing-on-macos).

Configure Chat model profiles in Settings or with shared `MODEL_*` environment variables. Default application data is `~/.quifox`; `QUIFOX_ROOT` and `QUIFOX_WORKSPACE` select an independent root/workspace. Multiple Hosts may share the root; different sessions run independently, while each session tree retains one execution owner.

Launching the executable from a terminal uses its current directory as the initial browsing directory; no `PWD` environment assignment is required. `--workspace /path/to/project` overrides that directory. The native folder picker above the composer selects a new conversation's working directory within the same window. Existing sessions retain their own directory and inherited configuration. In Plugins, the observation entry first shows searchable sessions grouped by project; select one to inspect its runs and return to the list without changing the active chat.

Startup shows a fresh conversation; select history explicitly. Use **⌘/Ctrl+N** for a new session, **Enter** to send and **Shift+Enter** for a newline. Select the current model and reasoning effort in the composer. Settings contain Queue/Steer, direct or per-operation authorization, MCP connections and Agent definitions. Markdown messages distinguish user/Agent roles; tools show concise operations and expandable actual differences. The right panel shows files, current-turn changes and child/background tasks; execution details open on demand. Light/dark themes follow system by default.

New session opens a blank conversation without a creation form. Choose its working directory through the native folder picker above the composer; cancelling keeps the draft. The first message saves the session. Without a selection, the Host creates `~/.quifox/workspaces/YYYY-MM-DD/new-chat`, adding `-2`, `-3` for further directories that day. Existing sessions display their original directory. The reasoning selector appears only when supported effort levels are known.

Settings open in the main pane and include Skills and Memory, available before creating a conversation. The upper-left Plugins entry lists installed capabilities; an existing session also exposes its actual assembly. Choose a Chat provider/model from Models.dev or configure a custom Chat connection. Reasoning levels remain unspecified when the metadata API omits them; enable manual capabilities to choose supported levels. Explicit capabilities take precedence, and the global `high` preference is sent only when supported.

Drafts survive navigation and rejected submissions; uncertain acknowledgements retry with the same identity. Enter a child session from the sidebar, task panel or trace and return through its parent button. Settings keep the current key when blank and preserve hidden connection parameters unless the URL is edited. Missing old workspaces/configuration remain readable, with execution disabled until restored.

Enter `/spawn 3 Review these requirements` to create idle children with empty history; use `/spawn --fork 3 Review the agreed plan` to copy one safe parent prefix. QuiFox permits one child level. The receipt exposes actual names and IDs with links to each child. `@Turing @Curie Review @Newton Search` sends the first message to Turing/Curie and the second to Newton. Recipient completion includes children created by model tools. Partial admission keeps the draft for a retry without duplicating accepted messages.

The resizable right workspace keeps separate tabs for source files, Markdown, images, videos and real current-turn differences. Toggle its file tree, filter nested files or choose a browsing directory without creating a session. Code views provide line numbers, syntax highlighting, find and wrapping; differences support side-by-side or unified display with unchanged-context folding. Images support fit, zoom and expanded preview; switching or closing a video stops playback. Files can also open in the default application or VS Code.

The Desktop presentation plugin lets the Agent call `open_view` to display a local file from any directory. Install and enable **Desktop presentation** from Plugins if it is not already installed. Relative paths use the session working directory. Its receipt confirms the actual opened tab; HTTP(S) URLs open in the external default browser. A full embedded browser is deferred. TUI hosts do not register this tool, and presentation instructions belong only to the current model request.

The browser-only Vite preview has no native engine. A frontend build, a native window and a real model request establish different results; this experimental Host does not claim production readiness or multi-platform acceptance.

See the [Desktop contract and behavior anchors](docs/specs/architecture.md).
