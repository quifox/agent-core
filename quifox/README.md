# QuiFox

English | [简体中文](README.zh-CN.md)

<img src="desktop/src/assets/fox.svg" alt="QuiFox fox" width="64" height="64">

QuiFox is a Harness built on [agent-core](../README.md), with terminal (TUI) and desktop (GUI) interfaces. It composes Core and framework plugins into interactive Agents with shared conversations, model connections, tool approvals, Skills, Memory, child tasks and execution traces.

## Components

| Directory | Responsibility | Details |
| --- | --- | --- |
| `tui/` | React/Ink terminal interface, keyboard navigation and streaming output | [TUI README](tui/README.md) |
| `desktop/` | Tauri/React desktop interface, project navigation and tool displays | [Desktop README](desktop/README.md) |
| `runtime/` | Shared Agent composition, commands, configuration, authorization, persistence and Host I/O | [Runtime README](runtime/README.md) |

Both interfaces submit commands to the same runtime and display its events. Desktop's Rust bridge owns the native window and sidecar process. Core and reusable plugins live in `../packages/`; `../examples/` contains framework composition examples.

## Install the terminal application

The npm installation package is named `quifox` and provides the TUI. It requires Node.js 22.12 or newer; the installation artifact does not require Bun.

> [!NOTE]
> The package has not been published to the npm registry yet. The following commands apply after publication; use the source instructions below for now.

```sh
npm install --global quifox
quifox
```

Run `quifox` from your project directory, or select another directory with `quifox --workspace /path/to/project`. After publication, `npx quifox` will also start the terminal application. See the [TUI guide](tui/README.md) for local package builds and keyboard controls.

## Run from source

Use Bun 1.4.0, pinned in the root manifest, and Node.js 22.12 or newer. Run these commands from the **repository root**:

```sh
bun install --frozen-lockfile
bun run build
```

Start the terminal interface:

```sh
bun run quifox/tui/src/cli.tsx --workspace /path/to/project
```

Start the native desktop interface after installing the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
bun run --filter @quifox/desktop desktop:dev
```

The component READMEs cover terminal installation, keyboard controls, native builds and detailed configuration.

## Models and local data

Configure model connections in Desktop Settings or the TUI's `/config` and `/model` panels. Both interfaces share the default `~/.quifox` data directory, including `config.json` and original session records. A new launch opens a fresh conversation; select history explicitly to resume an existing session.

`MODEL_API_KEY`, `MODEL_BASE_URL` and `MODEL_ID` override the default Chat connection for the running process. These overrides are not automatically saved. See [runtime configuration](runtime/README.md#configuration-and-data) for model profiles, isolated data roots, project configuration and MCP connections.

## Further reading

- [Application and package boundaries](../docs/specs/packages.md).
- [Shared runtime contract](runtime/docs/specs/architecture.md).
- [Desktop contract](desktop/docs/specs/architecture.md).
- [Framework architecture guide](../docs/guides/architecture.md).
