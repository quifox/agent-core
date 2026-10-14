# 运行中输入转向插件

## Host 的 Steer/Queue 接纳

MessageInboxPlugin 保存输入命令的稳定身份、原文、模式与 pending/staged/applied 接纳事实；Conversation 仍唯一拥有历史。参考 [Codex 输入预览](https://github.com/openai/codex/blob/cab328f2754e6ec53f6a61b1c58b51f15d7a4538/codex-rs/tui/src/bottom_pane/pending_input_preview.rs) 的下一工具边界 Steer 与后续 Queue 行为，仅借鉴可观察合同。

- Host 串行消费 Agent 流直到全部 onRunEnd 完成，然后通过 next 领取下一输入；不以计时器推测状态释放。运行期间的 Steer 在下一 beforeModel 的完整工具交换边界追加，Queue 等下一轮。已发出的请求不变化；末尾才到达的 Steer 保持 pending，收尾后作为下一轮，避免丢消息。
- 同一身份的同一参数重复投递幂等；身份参数冲突明确失败。各通道按到达顺序接纳，显示原顺序与模式；Steer 影响当前任务，Queue 指定后续任务，不把跨通道的执行先后冒称同一 FIFO。
- beforeModel 追加成功后才标 staged；Host 将 committedSnapshot 与 Session 快照作为一个持久记录写入，成功后 commitStaged。未被 Session 接纳的 claim 可 restoreStaged；已在冻结准备消息中的 staged 输入不能再次追加。具体重启核对归 Host。
- cancelPending 按明确消息身份只取消尚未领取的 pending 项，保留原文/身份并标为 cancelled；staged/applied 不被取消。cancelled 不重新领取、恢复或视作待处理，重复取消幂等。Host 将其与 Session 状态一起提交，取消不是已执行输入的回滚。
- 本插件不发起 run、不自动停止当前工具，不把接纳回执当作任务完成。与下述 RunSteeringPlugin 是两种显式组合选择，Host 不同时注册它们。

## 并发 run 合批组合

## 所有权与入口

- 调用方继续使用原 Agent 的 `run({ prompt })`。RunSteeringPlugin 不包装或替换 Agent 方法，只在最前面的 onRunStart 接纳调用。
- 插件只保存物理运行队列、等待调用和尚未写入会话的 prompt。Conversation 是 Message[]、存储、协议投影和失败重试的唯一 owner。
- 队首是唯一可进入 Conversation、Model、Tool、Events 与 Teams 的物理运行；其余 Core 调用停留在本插件的 onRunStart。

## 合批与停止

- 合批窗口在本插件的首次 beforeModel 中关闭，不以网络是否已经发送为判断。关闭前到达的 prompt 加入当前批次，不停止队首；所有调用共享当前物理运行的产物或主错误，各自仍有独立 Outcome 对象。
- 输入窗口关闭后到达的 prompt 进入下一批，并请求内部 InterruptPlugin 以 terminate 模式停止队首。已经进入 prepare/execute 的工具等待真实回执；余下调用得到停止回执并完整经过 afterTool。原因统一为 `stop`。
- 插件在注册阶段追加一个私有、同步且声明 `after: 'teams'` 的收尾对象，并把它保持在最终插件数组的最后一个 `onRunEnd` 位置。只有该对象观察到前面全部异步收尾完成后，下一批的首个调用才成为新物理运行；不得以 `setTimeout(0)` 猜测 Session、存储或其他插件已经释放状态。
- 如果当前物理运行在首次 `beforeModel` 前停止或失败，尚未交给 Conversation 的合批 prompt 不得作为旧运行的已处理输入结算；它们按到达顺序转移为下一批。已经写入 Conversation 的合批输入才共享当前物理运行的产物或主错误。
- 一批内保持调用到达顺序，不合并文本、不丢失输入，也不为每条消息额外调用模型。

## 失败与边界

- 物理运行成功时，合批调用取得同一个不透明 value；物理运行失败时，合批调用取得同一主错误。每个调用仍有自己的 AgentRunOutcome 对象。
- 合批调用不返回同一个 Outcome 对象，也不复制执行者的 errors 数组；等待调用后续的 onError/onRunEnd 仍可能为自己产生收尾错误。执行者完成完整收尾后才通知等待者。
- 等待调用没有进入后续插件的 onRunStart；后续插件的 onRunEnd 必须只处理自己接纳的 Outcome。
- `{ resume: true }` 不是用户消息，不参与合批；存在活动或等待批次时拒绝并发恢复。恢复仍由 Session 与 Checkpoint 的显式流程负责。
- 本包不取消已经开始的 I/O，不增加 Core 循环动作，不持久化等待队列。进程退出后，尚未交给 Conversation 的输入由宿主决定是否重发。

## 组合与验收

本插件必须是调用方候选数组首项，且同一实例只能出现一次；重复实例在初始化前明确失败，不能让同一 Outcome 再次进入接纳队列。插件内部直接组合 terminate 模式的 Interrupt，并在注册阶段追加私有收尾对象，无须再注册同一个中断策略。它接纳并发调用，不代表会话、事件或 Checkpoint 本身允许并发。等待调用的 stream 只获得自身 Core 入口/收尾事实，不重播执行者的模型事件；执行过程由执行者 stream 或显式 Events 出口观察。

[组合测试](../../test/plugin.test.ts) 必须覆盖首次 beforeModel 前合批、首次模型前早退的输入转移、异步 onRunEnd 完成后才交接、重复实例拒绝、工具执行中两条输入共同进入下一轮、已执行结果保留与剩余停止回执、并发 resume 拒绝。
