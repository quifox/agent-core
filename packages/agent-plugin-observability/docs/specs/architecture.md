# Observability / Eval 插件

本插件将单 Agent 的运行事实折叠为可持久化的指标和轨迹，不修改 Core，也不拥有执行策略。

- Run、Model、Tool、Error、Recovery、Evaluation 使用稳定结构化事件；时间由可注入 clock 计算。
- Token 来自模型公开 usage；没有 usage 时保持缺失，不估算或伪造。
- Tool 观测只记录名称、调用身份、状态、错误码和时延，不复制参数与回执正文。
- Model/Tool 在实际 Hook 边界分别记录 start 与回执；pending 保留开始但未收到回执的调用，闭合或重启不能把它们伪造为成功。调用次数统计已观察到的开始或真实回执，不等待最终结果才显示正在运行的请求。
- Run 终态区分 success、failed、interrupted、stopped；中断原因只记录稳定字符串。
- `recordRecovery` 与 `recordEvaluation` 是 Host 可调用的附加事实入口，不触发执行或重试。
- `composition` 是最近一次模型请求前的安全快照：插件列表、最终工具定义摘要、system/context 来源由 Host 提供；不在包内反射私有实现。
- 比较函数按 variant 聚合运行成功率、时延、模型/工具次数、Token 与显式 Eval。
- 未闭合运行保持 running，不进入完成运行的成功率和平均耗时比较；缺失 Token 不补零。Host 崩溃后未闭合事实保持未知，不能推断失败或成功。
- composition/variant/runId/clock 及 publisher 的观察异常保持非致命；公开 publishError 提供最近的采集异常，执行结果不因观测改变。
- 共享插件按 Context 隔离运行。不同 Context 可并行观测；同一 Context 的重叠 Outcome 无法从模型/工具 Hook 唯一归因时，停止该组细粒度采集并标记 incomplete，仍按各自 Outcome 闭合，不能拒绝 Agent 执行。不完整观测不进入比较；多活动运行的 Recovery/Eval 需明确 runId。
