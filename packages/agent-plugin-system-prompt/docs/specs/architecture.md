# 系统提示词插件

- 宿主显式注册普通插件并显式传入非产品绑定的可信内容；Core 与本包都不设置产品默认内容。
- beforeModel 在第一条非 system 消息之前插入可信静态 system 内容，保留已有 system 顺序；已有相同内容或内容为空时不重复添加。
- 插件不读取协议模式或后端游标。正式 Responses 接入插件负责投影增量：首次发送 system，续接使用服务端已保存的 system，不把重复 system 当作新历史。
- 应用身份与诊断提示词由实际 Host 或对应适配器保存。本包只实现静态 system 内容的贡献机制；摘要子 Agent 是否装配任何提示词由调用方决定。
- 其他可信插件可通过 beforeModel 修改完整 request.messages，包括修改 system 或补充最新 user。动态环境信息由具体插件追加到本轮 user；Core 不提供 append/replace/mode。
- onInitialize 可用于异步准备内容，固定文本无须初始化。运行期插件安装不属于当前合同。
- 提示词贡献可以委托组合插件的 addSystemPrompt，不要求调用方取得协议消息列表；原有直接消息 owner 仍使用自己的适配形式。
- 当前请求改写不等于覆盖远端历史；更新远端 system 需由具体后端能力另行实现。

beforeModel 每个模型阶段都调用本插件；同一内容是否已经加入由消息 owner 检查，不使用 Core 首轮标记。直接消息能力按 system 内容比较并在前缀插入；Conversation 能力委托 addSystemPrompt 去重及记录历史。独立会话与 Fork 使用各自 owner，不共享全局“已注入”状态。

本插件贡献可信 system，不保证任何模型绝对抵抗提示词注入；工具回执风险检测或权限拒绝属于显式 afterTool/beforeTool 插件及实际应用安全边界。
