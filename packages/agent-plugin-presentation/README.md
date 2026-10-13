# Presentation plugin

Host-injected Desktop presentation for local files, images and videos from any directory. The `open_view` tool returns a confirmed panel identity, or reports an HTTP(S) URL handed to an external browser.

`new PresentationPlugin({ open, context })` accepts the host's asynchronous presentation adapter and request-context writer. Register it only when the executing host can confirm views. File access, native integration and cancellation belong to the host; this package has no platform I/O. Tool access still follows the host's permission policy.

The request-only prompt is recalculated before each model request and is excluded from canonical conversation history. Unknown results are not declared safe to retry.

See [the contract](docs/specs/architecture.md), [shared host](../../quifox/runtime) and [Desktop](../../quifox/desktop).
