# 后台任务

独立后台任务插件提供提交能力，以及普通 task_get/task_wait/task_cancel 工具。Tool.execute 的 Promise 仍由原 Core 执行；提交工具返回任务身份，任务在插件中运行，不改变默认串行循环。

- 每个任务归属于提交它的长期 Agent Context；其他 Agent 不能查询或控制该任务。插件可在明确组合中复用，状态隔离仍由 owner 身份决定。
- 提交立即返回身份；running 表示操作尚无最终回执，completed 保存真实 ToolResult，failed 保存执行异常的公开文案。业务 ToolResult 为 error/denied 也属于已取得真实回执，不伪装成未执行。
- wait 只等待同一任务，超时保留任务和 running；重复查询或等待不再次执行。Host 可注入当前轮信号，中止立即结束等待并返回当前任务事实，不把等待中止当作后台操作完成。结束或中止时释放本次等待计时器与订阅。
- 公共回执是独立的状态快照，观察者不能改写执行事实；真实 ToolResult 的 status/content/code/reason 捕获后保留。可发布 data 独立复制；不可 JSON 表示或不可复制的可选 data 不进入观察回执，并标记 resultDataUnavailable。此情况不能把已成功的操作改判 failed；不收窄 Core 的 ToolResult 合同。
- 取消只发送 AbortSignal 并记录请求；在操作产生真实终态前仍保持 running。不能把取消请求写成回滚或无副作用保证。
- 生命周期由 Host 关闭入口收口实际操作与订阅；join 只供明确资源收尾等待已有 completion，不设置等待计时器或重复执行，仍验证长期 owner。模型工具 wait 继续有界等待。插件不引入文件、网络、进程或 Core 状态字段。
- newId 可由 Host 提供持久身份，onTask 观察状态变化但不能修改任务事实。restore 在长期 owner 初始化时重建观察回执；跨进程遗留 running 转为 unknown，不复建操作函数或假装旧进程仍在运行。
