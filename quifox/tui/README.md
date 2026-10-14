# QuiFox TUI

[English](README.md) | [简体中文](README.zh-CN.md)

A React/Ink terminal Host with the blue fox, yellow ears and **QUIFOX** wordmark. It uses [shared-runtime](../runtime/README.md) for every Agent capability.

Assistant messages render Markdown headings, lists, tables and syntax-highlighted code. User messages appear as white rows with black text; the transcript omits role labels. Color is disabled when `NO_COLOR` is set.

The npm installation package is named `quifox`; it runs the same TUI on Node.js 22.12+ without a separate Bun installation. Registry publication is separate from building the package. To try the prepared artifact locally, run from the repository root:

```sh
bun run --filter @quifox/tui npm:build
cd quifox/release/npm/quifox
npm pack --ignore-scripts
npm install --global ./quifox-0.1.0.tgz
quifox
```

Run `quifox` from your project directory after installation; `--workspace` is an optional override. Published installation will use `npm install --global quifox` or `npx quifox`. The npm artifact bundles the shared Host and framework plugins, so those workspace packages do not need separate publication.

After the workspace build, start from the repository root:

```sh
bun run quifox/tui/src/cli.tsx --workspace /path/to/project
```

Configure the Chat connection with `MODEL_API_KEY`, `MODEL_BASE_URL`, `MODEL_ID` or the shared JSON config. Pass `--root /path/to/isolated-root` for a separate data directory. `--prompt "Explain the project"` runs one batch turn; batch mode denies tools requiring interactive approval.

Normal startup opens a new main session. `--resume` opens a history picker; `--resume SESSION_ID` selects a known session. Multiple terminal/native Hosts may share the data root and work on different sessions.

| Control | Behavior |
| --- | --- |
| Enter / Shift+Enter | Send / insert a newline |
| Tab | Complete a slash command, Skill or @ recipient |
| Up / Down | Filter/select commands or scroll output |
| Escape | Close a panel or request stop |
| Ctrl+C | Close the Host and exit |
| Up / Down, then Enter in an approval | Approve once, deny, or deny with a reply |
| `/new [directory]`, `/resume`, `/open SESSION_ID` | Create or explicitly select a session |
| `/tasks` | Select a child task or return to its parent |
| `/spawn [--fork] [count] [instructions]` | Create idle children; copy the parent prefix only with `--fork` |
| `/continue`, `/stop` | Resume with replanning or stop the actual run |
| `/config [JSON]`, `/model`, `/effort`, `/models` | Visual settings, model/effort selection or metadata refresh |
| `/mcp`, `/agents` | MCP connections and Markdown Agent definitions |
| `/skills`, `/memory`, `/trace`, `/help` | Inspect shared resources and events |

Use `$skill-name` to select a Skill whose name conflicts with a built-in command. `$catalog-identity` selects its exact source; ordinary `/skill-name` completion uses the nearest scope.

`/spawn 3 Review these requirements` returns three names and IDs with empty history, without requesting a model. Use `/spawn --fork 3 Review the agreed plan` to copy the safe parent prefix. QuiFox allows one child level. `@Turing @Curie Review the code @Newton Search related issues` broadcasts the first message to Turing/Curie and sends a separate message to Newton. Use returned names or IDs; completion includes model-created children. Failed deliveries keep the draft for an identity-preserving retry.

Set Queue/Steer and global tool permissions in `/config`; current-session permissions have a separate menu. Queue waits for complete execution and cleanup; Steer joins the next complete request boundary. Unknown tool effects remain unknown. Ordinary `y`/`n` text never grants approval. The approval menu previews the operation and uses explicit keyboard selection. Denying with a reply appends your explanation to the original tool result, preserving the message draft. The terminal viewport keeps the brand and input visible; long drafts show the area around the cursor. `/trace` opens real parameters, receipts and file differences.

Add a standard stdio server from the command line, then use `/mcp` to connect:

```sh
bun run quifox/tui/src/cli.tsx mcp add local -- npx -y server-package
```

This stores the command; the MCP SDK starts it only when you connect or run an authorized Agent. For HTTP use `mcp add local --url https://server.example.test/mcp`. Project MCP configuration requires explicit directory authorization.
