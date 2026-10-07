# @quifox/agent-plugin-system-prompt

[English](README.md) | 简体中文

系统提示词插件。行为与边界见 [架构规范](docs/specs/architecture.md)。

Host 显式调用 `createSystemPromptPlugin(messages, content)` 并传入可信静态内容。Core 和本包都不提供产品默认提示词；产品身份与诊断规则留在实际 Host。

提示词插件在 `beforeModel` 通过调用方提供的消息能力或 `addSystemPrompt` 贡献 system 内容；不需要 Core 的 `append / replace / mode` 配置。具体会话插件负责协议投影，正式 Responses 在首次发送后沿用远端 system。环境信息由相应插件补充到新的 user 输入中；当前请求贡献不覆盖远端历史。
