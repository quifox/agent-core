import type { RuntimeConfig } from './config.js'

export const builtinPlugins = [
    { id: 'langchain', name: 'LangChain', description: 'LangChain 系列与工作流设计、交付检查 Skill 集；按需加载文档。' },
    { id: 'workflows', name: '工作流', description: '通过脚本编排多 Agent，运行前校验；界面提供脚本库与调用图。', surface: { kind: 'workflows', title: '工作流' } },
    { id: 'knowledge', name: '知识检索示例（Mock）', description: '本地合成资料的检索接口示例，可追加到工作流 Agent；不连接真实知识服务。' },
    { id: 'skills', name: '技能', description: '发现和加载工作目录与全局技能。' },
    { id: 'project-guidance', name: '项目指引', description: '按目录层级注入 AGENTS.md 开发约束。' },
    { id: 'memory', name: '记忆', description: '保存任务记忆与会话摘要，按需要注入下一轮上下文。' },
    { id: 'chat-compaction', name: '上下文压缩', description: '接近容量边界时压缩会话，保留恢复所需信息。' },
    { id: 'background-tasks', name: '异步任务', description: '等待和取消后台操作；命令执行依赖此能力，停用后不提供命令工具。' },
    { id: 'host-native-tools', name: '编程工具', description: '执行命令与精确文本替换，复用宿主授权。' },
    { id: 'subagents', name: '子智能体', description: '创建、唤醒、等待和停止独立子任务。' },
    { id: 'presentation', name: 'Desktop 展示', description: '在 Desktop 标签页展示文件、图片与视频；URL 交给外部浏览器。仅 GUI 宿主装配。' },
    { id: 'observability', name: '运行观察', description: '检查执行轨迹、模型与工具指标以及请求上下文。', surface: { kind: 'observability', title: '运行观察' } }
] as const

export function pluginEnabled(config: RuntimeConfig, id: string): boolean {
    if (id === 'workflow-model') return pluginEnabled(config, 'workflows')
    if (id.startsWith('mcp:')) return config.mcp.find(server => server.id === id.slice(4))?.enabled ?? false
    if (builtinPlugins.some(plugin => plugin.id === id) && !config.installedPlugins.includes(id)) return false
    return config.plugins[id as keyof RuntimeConfig['plugins']] ?? true
}

export function installedPlugins(config: RuntimeConfig, global: RuntimeConfig) {
    return [...builtinPlugins.filter(plugin => config.installedPlugins.includes(plugin.id)).map(plugin => ({ ...plugin, source: 'builtin' as const, enabled: pluginEnabled(config, plugin.id), globalEnabled: pluginEnabled(global, plugin.id) })),
        ...config.mcp.map(server => ({ id: `mcp:${server.id}`, name: server.id, description: `MCP · ${server.transport}`, source: 'mcp' as const,
            enabled: server.enabled, globalEnabled: global.mcp.find(item => item.id === server.id)?.enabled ?? true }))]
}

export function pluginMarketplace(config: RuntimeConfig) { return builtinPlugins.map(plugin => ({ ...plugin, installed: config.installedPlugins.includes(plugin.id), source: 'builtin' as const })) }
