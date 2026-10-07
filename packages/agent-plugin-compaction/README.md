# @quifox/agent-plugin-compaction

English | [简体中文](README.zh-CN.md)

Context budget and summary policy. CompactionPlugin uses the conversation/modelInfo capabilities to create an isolated summary branch, then waits for valid submission before continuing the main model. ChatCompactionSource owns Chat-specific slicing and checkpoint projection.

The first two candidates preserve the Tool prefix; a candidate Tool call stops summary generation without executing that Tool. The third attempt removes Tools and selects none. Only a complete, Tool-free summary that reduces the budget is submitted. Original records and recent complete Tool batches remain preserved.

The threshold uses contextWindow minus the current maxOutputTokens; a separate input limit also participates. New user input and growing Tool results pass through the same beforeModel boundary. Hook ordering follows the owning conversation contract.

See the [compaction specification](docs/specs/architecture.md).
