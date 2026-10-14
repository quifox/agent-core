# 知识检索插件

KnowledgePlugin 通过 Host 注入 retrieve 函数注册 knowledge_retrieve。输入为 question 与可选 documentIds；输出包含正文、来源文档与可选相似度，工具 content 提供可读引文。插件与默认工具描述不绑定具体检索服务、网络、认证或资料存储，也不维护会话；既可直接装配，也可追加到工作流 Agent。Host 可通过第二个 description 参数说明自己的资料边界；回调失败不能伪装空结果。QuiFox 当前仅提供可选的本地 Mock 回调，工具描述、示例资料与来源明确标记合成，不代表真实知识或检索质量。
