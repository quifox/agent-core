import { convertFileSrc, invoke } from '@tauri-apps/api/core'

export const nativeViews = {
    async chooseDirectory(current: string, title = '选择浏览目录'): Promise<string | null> { return invoke('workspace_pick', { directory: current, title }) },
    async asset(path: string): Promise<string> { const resolved = await invoke<string>('view_asset', { path }); return convertFileSrc(resolved) },
    async external(target: string, mode: 'default' | 'editor' | 'reveal' = 'default'): Promise<void> { await invoke('view_external', { target, mode }) }
}
