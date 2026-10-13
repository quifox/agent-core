# 本轮执行记录插件

- 记录一个模型轮的完整产物、每个调用的 not-started / started / completed 状态和收到的结果；不持有跨轮会话权威历史，不扩展 Core。
- onRunStart 成功后绑定自身接纳的 Outcome。onRunEnd 只修改和释放该 Outcome 的物理运行状态；在接纳前被拒绝、停止或合批的调用，不能清理其他调用的恢复状态或入口暂记。同一对象重复插入时保留同一归属。
- onInitialize/onRunStart 在插件 Context 扩展中发布 execution；afterModel 接纳新工具轮，beforeTool 暂记 started，afterTool 保存真实结果。前置链 stop 时没有进入工具入口，onRunEnd 将本次暂记还原为进入前的状态，不依赖 Checkpoint 与停止插件的数组顺序。异常且没有回执时保留保守的未知状态，不把缺少回执当成未执行。完整 afterStep 清空本轮记录；如果前置停止处理器跳过了 afterStep，但全部调用都已取得真实或明确停止回执，onRunEnd 同样清空。中断或错误只保留仍未闭合的工具轮；无工具调用的最终模型轮不保留待恢复记录。
- 标准装配顺序将路由、权限、Interrupt 等可能停止或拒绝的 beforeTool 处理器放在 Checkpoint 前面；Checkpoint 后只放不改变控制决定的观察处理器，使 started 尽量贴近真实工具入口。顺序不是安全性的唯一依赖，前置链正常 stop 仍必须回滚暂记。
- snapshot/fork 显式复制数据，不复制 Promise、业务资源或正在运行的函数栈。恢复需 Session 的对应快照和同样的工具组合。
- `{resume:true}` 将未完成的调用作为一次临时模型产物交回 Core 原有工具循环，已完成调用不重复。本插件不在 onRunStart 拒绝 started 调用；通过 execution.requiresRetry(callId) 查询该调用进入本次恢复前是否结果未知，重试或停止由独立策略插件决定。该查询不受本轮 beforeTool 暂记的影响。默认安全恢复组合显式注册 InterruptPlugin；自定义组合自行提供策略，本插件不隐式安装它。onRunStart 在新输入覆盖未完成记录之前拒绝。
- 恢复轮的 Session 不重复接纳 assistant；全部结果闭合后，下一模型轮使用原有效上下文并按正常压缩屏障发送。
- 没有工具记录时，resume 不伪造工具轮，只允许配对 Session 从其已接纳上下文继续模型请求。尚未接纳的原输入仍由 Host 以原 prompt 冻结重试；不能把本插件没有记录解读为未知副作用安全。
- 本插件默认内存保存；跨进程恢复必须同时保存/恢复本轮快照和 Session 快照，不能只凭缺少工具消息就认定操作未执行。

## 状态含义与恢复选择

| 状态 | 可以确认 | 不可以据此确认 |
|---|---|---|
| not-started | 本记录没有未收口的入口暂记 | 其他进程或绕过本组合的操作没有副作用 |
| started | beforeTool 已暂记，尚未被 afterTool 收口 | execute 必定开始，或业务必定没有执行 |
| completed | afterTool 或显式 confirm 保存了结果 | 工具业务成功；error/denied/停止回执同样是 completed |

prepare 抛错、execute 抛错或前置后项抛错都可能留下保守的 started。本插件没有 prepare/execute 之间的额外观察点，不为区分这些情况增加 Core Hook；恢复策略对未知结果保持保守。

正常前置 stop 的 Outcome 为成功时，onRunEnd 回滚本次暂记；失败 Outcome 不据缺少回执回滚为 not-started。其后某个独立收尾 handler 若改变 Outcome，不追溯重跑已完成的 Checkpoint 收尾。

confirm 只更新本轮执行记录。Session 或 Conversation 的 confirmTool 是另外的消息保存命令；宿主必须把两者作为一次配对提交。可以暂记 Checkpoint 后让 Session 的 store 保存同一状态记录；保存失败时用 restore 还原先前 Checkpoint，不能只推进一个 owner 后宣称恢复完成。restore 只允许在没有物理运行时使用。

没有工具记录时，只有显式 canResumeModel 回调核实配对会话存在已接纳的待完成请求，才允许继续模型请求；默认回调不接受无依据续跑。

## 能力发布与组合

Context.execution 只指向本插件的协作能力，不是 Core 固定字段。next 返回当前工具轮的派生副本，仅包含尚未 completed 的调用；结果仍交回原串行 for，不直接调用 handler。

本插件不单独实现并发接纳。其 state/entering 属于当前物理运行，调用方需通过会话串行约束或前置 Steering 保证一个物理执行者。

行为验收见 [执行记录与恢复测试](../../test/plugin.test.ts) 和 [Steering 批次闭合测试](../../../agent-plugin-steering/test/plugin.test.ts)。
