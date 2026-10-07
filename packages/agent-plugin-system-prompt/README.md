# @quifox/agent-plugin-system-prompt

English | [简体中文](README.zh-CN.md)

Trusted system-prompt contributions. The Host calls createSystemPromptPlugin(messages, content) with explicit static content; product identity and diagnostics belong to that Host.

beforeModel contributes through the supplied message capability or addSystemPrompt. The concrete session owns protocol projection; Responses retains remote system history after its first send. Environment information belongs to the relevant plugin and new user input, rather than overwriting ancestor history.

See the [contract](docs/specs/architecture.md).
