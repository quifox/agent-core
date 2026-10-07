/** 插件拥有事件内容，Core 仅转发；完整观察类型由各自插件提供。 */
export interface AgentEvent { type: string; [key: string]: unknown }
