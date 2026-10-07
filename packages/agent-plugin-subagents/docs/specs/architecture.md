# 子智能体插件

- onInitialize 注册 subagent_start 与 subagent_wait；execute 使用 ctx 中的 Conversation 能力，模型输入不包含 Context。
- start 的 empty 创建空历史，fork 从父未闭合工具批次之前复制完整前缀与压缩点。父 Session 不变化，子 Model 和压缩适配器重绑子 Session。
- 子插件组合由调用方提供的 plugins(conversation, ctx) 显式构造，必须包含给定子会话；其他插件、闭包、I/O 与权限的派生或共享由调用方明确选择。
- start 不等待子执行完成；插件立即持有成功/失败处理器并返回本插件的 taskId。此标识不是 Core runId。
- wait 默认最多等待十秒，可配置有界时长；超时返回 running，不取消子任务。后续 wait 返回同一最终结果，已完成任务不重复执行。
- 完成内容读取子调用自身 Outcome.value 中的 ModelTurnResult：文本非空且没有工具调用时完成；失败 Outcome、缺少回复或不包含回复的停止产物不算完成。历史或 readOutput 不能证明本次调用产生了输出；提前停止不得返回继承的父回复，而本轮新生成的同样文本仍然有效。失败回执不暴露堆栈。子任务状态只属于本插件，等待计时器每次结束都释放。
- 运行中的任务不被淘汰。完成或失败结果按完成顺序有界保留，默认保留最近 100 个，可由 `maxCompletedTasks` 调整；超过边界后最旧 taskId 变为不存在。保留期内重复 wait 返回同一最终结果，不重新执行子任务。
- 当前为进程内子任务；不提供进程重启后的任务调度、父取消级联、默认递归创建或 UI 展示。
