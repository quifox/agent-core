# Contributing

QuiFox is an experimental research project. Public contracts may change before 1.0.

1. Use the Bun version pinned in the root manifest and install with `bun install --frozen-lockfile`. Keep Node.js 22.12+ available for the existing Vitest and V8 coverage tooling.
2. Work on a short-lived topic branch; main is updated through reviewed changes.
3. Update the owning specification before behavior changes, then regression tests and implementation.
4. Follow the [shared authoring contract](docs/guides/plugin-authoring.md). Maintain each plugin's use guide inside its package; import only public entry points.
5. Build with `bun run build`, then use `bun run --filter <package-name> check` for affected packages or `bun run check` for the root gate. Coverage uses `bun run test:coverage`; `bun test` does not run the existing Vitest suite. Describe actual evidence and unverified boundaries.
6. Follow the repository's AGENTS.md conventions. Preserve unrelated source changes and history.

Do not commit credentials, personal conversations, local paths, logs, dist, or node_modules. Source license and third-party attribution remain in their dedicated files.

QuiFox applications live together under `quifox/desktop`, `quifox/tui`, and `quifox/runtime`. The framework plugins remain in `packages/`; applications are not standalone repositories or npm distributions. All manifests remain private until a separately authorized npm release.

For browser UI acceptance, run `bun run --filter @quifox/desktop test:ui` after installing Chromium from the desktop directory with `bun x --no-install playwright install chromium`. `PLAYWRIGHT_CHANNEL=chrome` can use a locally installed Chrome. Tests drive the production React UI and bridge client with synthetic responses; screenshots, reports and traces are written to ignored `artifacts/ui`. Native window and sidecar acceptance must be reported separately.

The Check workflow runs the repository gate and browser acceptance. QuiFox packages builds native CLI binaries and desktop installers on Linux x64, macOS ARM64 and Windows x64, using native sidecar targets as described in the [Tauri pipeline guide](https://v2.tauri.app/distribute/pipelines/github/). Pull requests, main, manual runs and `quifox-v*` tags produce Actions artifacts; the workflow does not publish a GitHub Release or npm package. macOS uses ad hoc signing; notarization and Windows signing are not configured. Verify the Actions results and installer behavior before publishing a release. Dependency notices and an inventory accompany the artifacts; review Bun's [linked-library and relinking instructions](https://bun.com/docs/project/license) before public binary distribution.

The initial installer formats are Linux `.deb`, macOS `.dmg`, and Windows NSIS `.exe`. Linux defaults to `.deb`; CI checks that its embedded engine is byte-identical to the compiled source. AppImage is deferred because the current deployment pipeline fails while rewriting/checking the Bun sidecar. Disabling symbol stripping did not resolve the observed failure. ELF rewriting has also affected compiled Bun executables [upstream](https://github.com/oven-sh/bun/issues/4103); that historical report does not establish that today's bundled output is safe.
