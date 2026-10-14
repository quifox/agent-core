# 知识检索插件

[English](README.md) | [简体中文](README.zh-CN.md)

KnowledgePlugin 用 Host 注入的检索函数注册 knowledge_retrieve。Agent 获得可读证据与文档来源；接口不绑定服务、不建立连接、不管理凭证。QuiFox 仅提供可选的本地 Mock 示例，资料与来源明确标记为合成。

可以直接装配，也可在 QuiFox 安装 Mock 示例后，通过 plugins: ["knowledge"] 追加到工作流。空结果与回调失败分开处理；Mock 运行仅验证集成，不证明真实检索质量。参见 [工作流指南](../../quifox/runtime/docs/guides/workflows.zh-CN.md)。

默认工具描述与后端无关。Host 可用第二个 description 参数说明自己的资料限制；QuiFox 用它明确标记本地 Mock。
