# 工作流插件

[English](README.md) | [简体中文](README.zh-CN.md)

WorkflowModelPlugin 通过 Host 注入的执行器提供模型回合；WorkflowToolsPlugin 提供检查、保存和运行工具。本包没有文件系统、编译器或网络依赖，相关 I/O 归 QuiFox 共享 Host。

会话由组合的 Session 与持久化插件拥有。可运行脚本、Skill 自动发现、GUI、API 和恢复说明见 [工作流指南](../../quifox/runtime/docs/guides/workflows.zh-CN.md)。
