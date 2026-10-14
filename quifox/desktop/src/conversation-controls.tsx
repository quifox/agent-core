import type { RuntimeCommand, SessionView } from '@quifox/shared-runtime'
import { FileDiff } from './presentation.js'
import { OperationView } from './operation-view.js'
import { Icon } from './icons.js'
import { SectionDescription } from './ui.js'

const riskDescription = { 'read-only': '读取文件或查询状态', write: '写入工作目录文件', execute: '执行命令或外部工具', 'outside-workspace': '访问工作目录外的路径' }
type Command = (command: RuntimeCommand) => Promise<unknown>
export function ApprovalCards({ view, command, error }: { view: SessionView; command: Command; error(cause: unknown): void }) {
    return !!view.approvals.length && <section className="approval-card" aria-label="工具授权">{view.approvals.map(approval => <div key={approval.id}><div className="approval-content"><h3>需要你的批准</h3><div className="operation-title">{approval.inspection?.summary ?? approval.call.name}</div><SectionDescription>{approval.inspection && riskDescription[approval.inspection.risk]}</SectionDescription>{approval.inspection?.change && <FileDiff change={approval.inspection.change} workspace={view.workspace}/>}<OperationView call={approval.call}/></div><div className="approval-actions"><button className="primary" onClick={() => { void command({ type: 'approve', sessionId: view.id, approvalId: approval.id, approved: true }).catch(error) }}>批准这一次</button><button onClick={() => { void command({ type: 'approve', sessionId: view.id, approvalId: approval.id, approved: false }).catch(error) }}>拒绝</button></div></div>)}</section>
}
export function QueuedMessages({ view, command, error }: { view: SessionView; command: Command; error(cause: unknown): void }) {
    const queued = view.pendingMessages.filter(message => message.mode === 'queue' && message.status !== 'staged')
    return !!queued.length && <section className="queued-messages" aria-label="排队消息"><div className="pending-strip" role="status">{queued.length} 条消息排队中</div>{queued.map(message => <div className="queued-message" key={message.id}><span title={message.prompt}>{message.prompt}</span><button type="button" aria-label={`引导消息：${message.prompt}`} onClick={() => { void command({ type: 'inbox', sessionId: view.id, action: 'steer', messageId: message.id }).catch(error) }}>引导</button><button type="button" aria-label={`删除排队消息：${message.prompt}`} onClick={() => { void command({ type: 'inbox', sessionId: view.id, action: 'cancel', messageId: message.id }).catch(error) }}><Icon name="close"/></button></div>)}</section>
}
