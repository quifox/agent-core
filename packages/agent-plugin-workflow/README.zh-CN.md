# 工作流插件

[English](README.md) | [简体中文](README.zh-CN.md)

WorkflowModelPlugin 通过 Host 注入的执行器提供模型回合；WorkflowToolsPlugin 仅提供 workflow_run，接受文件路径、库名称或一次性源码。脚本通过普通文件操作保存；Host 运行前校验，以 WorkflowInputError 返回可修正的诊断。可选上下文 writer 与 Skill 路径提供简短编写提示。本包没有文件系统、编译器或网络依赖，相关 I/O 归 QuiFox 共享 Host。

会话由组合的 Session 与持久化插件拥有。可运行脚本、Skill 自动发现、GUI、API 和恢复说明见 [工作流指南](../../quifox/runtime/docs/guides/workflows.zh-CN.md)。
