# Contributing

Agent Core is an experimental research project. Public contracts may change before 1.0.

1. Use Node.js 22 or 24 and the pnpm version pinned in the root manifest.
2. Work on a short-lived topic branch; main is updated through reviewed changes.
3. Update the owning specification before behavior changes, then regression tests and implementation.
4. Follow the [shared authoring contract](docs/guides/plugin-authoring.md). Maintain each plugin's use guide inside its package; import only public entry points.
5. Run the affected package check and the available root gate. Describe actual evidence and unverified boundaries.
6. Follow the repository's AGENTS.md conventions. Preserve unrelated source changes and history.

Do not commit credentials, personal conversations, local paths, logs, dist, or node_modules. Source license and third-party attribution remain in their dedicated files.
