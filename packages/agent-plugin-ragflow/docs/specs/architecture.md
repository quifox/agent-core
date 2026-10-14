# RAGFlow 检索插件

RagFlowPlugin 通过 Host 注入 retrieve 函数注册 knowledge_retrieve。输入为 question 与可选 documentIds；连接与 dataset 范围由 Host 绑定，模型不能扩大数据集。输出包含正文、来源文档与相似度，工具 content 提供可读引文而非原始服务回包。空结果明确说明，没有连接或服务失败不能伪装无结果。插件不维护会话，既可直接装配，也可追加到工作流 Agent。
