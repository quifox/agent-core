export const MEMBERS = [
    { id: 'A', label: 'Agent A', responsibility: '拆解与整合', color: 'blue' },
    { id: 'B', label: 'Agent B', responsibility: '资料归纳', color: 'purple' },
    { id: 'C', label: 'Agent C', responsibility: '约束核对', color: 'amber' },
    { id: 'D', label: 'Agent D', responsibility: '表达建议', color: 'green' }
] as const
export type MemberId = typeof MEMBERS[number]['id']
export const DEFAULT_TASK = '请分析一场40人、40分钟、预算不超过900元的海洋保护工作坊。根据你的职责处理；需要协作时向其他成员发送消息。'
