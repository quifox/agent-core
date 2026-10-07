# @quifox/agent-plugin-compaction

[English](README.md) | 简体中文

压缩策略与摘要提示词。`CompactionPlugin` 通过 Context 的 conversation/modelInfo 能力准备隔离摘要分支，等待生成及有效提交后才继续主模型。Chat 的消息切分与检查点封装在 `ChatCompactionSource` 中。

两次候选保持工具前缀；若出现工具调用，afterModel 停止候选，不执行工具。第三次清空工具集并设置 none。仅完整、无工具调用且能降低预算的摘要可提交；原始记录不删除，最近完整工具批次原样保留。

达到 contextWindow - 本轮 maxOutputTokens 时压缩；独立输入上限也参与预算。用户新输入与工具结果增长都走同一 beforeModel。按插件顺序放在消息准备之后，普通请求仍可变，不增加发送前自动锁定。

详见[压缩规范](docs/specs/architecture.md)。
