import { expect, it, vi } from 'vitest'
import type { EngineFrame, PresentationRequest } from '../src/protocol.js'
import { PresentationBridge } from '../src/presentation-host.js'

const request: PresentationRequest = { id: 'request-one', sessionId: 'session-one', operationId: 'operation-one', workspace: '/synthetic', target: '/synthetic/image.png' }
it('waits for a correlated UI receipt', async () => {
    const frames: EngineFrame[] = [], bridge = new PresentationBridge(async frame => { frames.push(frame) })
    let completed = false
    const pending = bridge.open(request).then(value => { completed = true; return value })
    await Promise.resolve()
    expect(frames).toEqual([{ kind: 'presentation', request }]); expect(completed).toBe(false)
    bridge.confirm(request.id, { ok: true, receipt: { destination: 'panel', viewId: 'view-one', target: request.target, kind: 'image' } })
    await expect(pending).resolves.toMatchObject({ destination: 'panel', viewId: 'view-one' })
    bridge.close()
})

it('settles a mismatched destination as an immediate failure rather than waiting for timeout', async () => {
    const bridge = new PresentationBridge(async () => {})
    let failure: Error | undefined
    try {
        const pending = bridge.open(request).catch(cause => { failure = cause as Error })
        expect(() => bridge.confirm(request.id, { ok: true, receipt: { destination: 'external', target: request.target } })).toThrow('不匹配')
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
        expect(failure).toBeInstanceOf(Error)
        await pending
    } finally { bridge.close() }
})

it('settles cancelled and expired requests without claiming a view opened', async () => {
    vi.useFakeTimers()
    const frames: EngineFrame[] = [], bridge = new PresentationBridge(async frame => { frames.push(frame) }, 100)
    const controller = new AbortController()
    try {
        const aborted = bridge.open(request, controller.signal)
        const rejected = aborted.catch(cause => cause as Error)
        controller.abort(); expect(await rejected).toHaveProperty('message', expect.stringContaining('不会回滚'))
        const expired = bridge.open({ ...request, id: 'expired' })
        const timeout = expired.catch(cause => cause as Error)
        await vi.advanceTimersByTimeAsync(100); expect(await timeout).toHaveProperty('message', expect.stringContaining('可能已打开'))
        expect(frames.filter(frame => frame.kind === 'presentation-cancel')).toHaveLength(2)
        bridge.confirm(request.id, { ok: true, receipt: { destination: 'panel', viewId: 'late', target: request.target, kind: 'image' } })
    } finally { bridge.close(); vi.useRealTimers() }
})
