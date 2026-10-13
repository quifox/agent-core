import { useMemo, type ReactNode } from 'react'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react'
import type { SessionView } from '@quifox/shared-runtime'

/** assistant-ui observes Host projections; it never creates or persists another conversation. */
export function ChatRuntime({ view, live, onSubmit, onCancel, children }: { view: SessionView | undefined; live: string; onSubmit(prompt: string): Promise<void>; onCancel(): Promise<void>; children: ReactNode }) {
    const messages = useMemo<ThreadMessageLike[]>(() => {
        const items: ThreadMessageLike[] = []
        for (const entry of view?.messages ?? []) if (entry.message.role === 'user' || entry.message.role === 'assistant') {
            items.push({ id: entry.id, role: entry.message.role, content: [{ type: 'text', text: entry.message.content }] })
        }
        for (const item of view?.pendingMessages ?? []) if (item.mode === 'steer' || item.status === 'staged') items.push({ id: item.id, role: 'user', content: [{ type: 'text', text: item.prompt }] })
        if (live) items.push({ id: 'host-live-output', role: 'assistant', content: [{ type: 'text', text: live }] })
        return items
    }, [view?.messages, view?.pendingMessages, live])
    const runtime = useExternalStoreRuntime({ messages, convertMessage: message => message, isRunning: view?.status === 'running',
        onNew: async message => { await onSubmit(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')) }, onCancel })
    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
