import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelCatalogView, RuntimeSnapshot } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('lists a cached Chat provider and its models without creating a session or inventing reasoning levels', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        await writeFile(join(fixture.root, 'models.json'), JSON.stringify({
            synthetic: { id: 'synthetic', name: 'Synthetic Chat', npm: '@ai-sdk/openai-compatible', api: 'https://synthetic.test/v1', models: {
                chat: { id: 'chat', name: 'Chat', reasoning: true, tool_call: true, modalities: { output: ['text'] }, limit: { context: 12000, output: 2000 } },
                image: { id: 'image', name: 'Image', tool_call: false, modalities: { output: ['image'] }, limit: { context: 1000, output: 1000 } }
            } },
            native: { id: 'native', name: 'Other protocol', npm: '@ai-sdk/native', api: 'https://native.test', models: {} }
        }))
        await fixture.restart()
        const catalog = await fixture.runtime.command({ type: 'model-catalog', provider: 'synthetic' }) as ModelCatalogView
        expect(catalog.providers).toEqual([{ id: 'synthetic', name: 'Synthetic Chat', baseUrl: 'https://synthetic.test/v1' }])
        expect(catalog.models).toEqual([{ id: 'chat', name: 'Chat', contextWindow: 12000, maxOutputTokens: 2000, reasoning: true, reasoningSource: 'models.dev' }])
        expect(catalog.cached).toBe(true)
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(0)
        expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
})

it('coalesces metadata fetches, sends no model credentials and preserves the cache after a refresh failure', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const registry = { synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', api: 'https://synthetic.test', models: {} } }
    let finish!: () => void, calls = 0, fail = false
    const blocked = new Promise<void>(resolve => { finish = resolve })
    const fetchMetadata = vi.fn(async (_url: string, _init: RequestInit) => { calls += 1; await blocked; if (fail) return new Response('', { status: 503 }); return new Response(JSON.stringify(registry), { status: 200, headers: { 'Content-Type': 'application/json' } }) })
    vi.stubGlobal('fetch', fetchMetadata)
    try {
        const first = fixture.runtime.command({ type: 'model-catalog', provider: 'synthetic', refresh: true })
        const second = fixture.runtime.command({ type: 'model-catalog', provider: 'synthetic', refresh: true })
        await expect.poll(() => calls).toBe(1)
        finish(); await Promise.all([first, second])
        expect(fetchMetadata).toHaveBeenCalledWith('https://models.dev/api.json', { signal: expect.any(AbortSignal) })
        const saved = await readFile(join(fixture.root, 'models.json'), 'utf8')
        expect(saved).not.toContain('synthetic-key')
        fail = true
        await expect(fixture.runtime.command({ type: 'model-catalog', refresh: true })).rejects.toThrow('已有连接')
        expect(await readFile(join(fixture.root, 'models.json'), 'utf8')).toBe(saved)
        expect((await fixture.runtime.command({ type: 'model-catalog', provider: 'synthetic' }) as ModelCatalogView).cached).toBe(true)
        expect(fixture.requests).toHaveLength(0)
    } finally { finish(); vi.unstubAllGlobals(); await fixture.close() }
})

it('cancels a pending directory request when the Host closes', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    let began!: () => void, cancelled = false
    const ready = new Promise<void>(resolve => { began = resolve })
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        began(); init.signal!.addEventListener('abort', () => { cancelled = true; reject(init.signal!.reason) }, { once: true })
    }))
    const request = fixture.runtime.command({ type: 'model-catalog', refresh: true })
    const outcome = request.catch((error: unknown) => error)
    try { await ready; await fixture.runtime.close(); expect(await outcome).toBeInstanceOf(Error); expect(cancelled).toBe(true) }
    finally { vi.unstubAllGlobals(); await fixture.close() }
})

it('automatically refreshes an expired catalog once and keeps its previous content on failure', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const registry = { synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Cached', api: 'https://synthetic.test', models: {} } }
    await writeFile(join(fixture.root, 'models.json'), JSON.stringify(registry)); await fixture.restart()
    const clock = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(clock)
    const fetchMetadata = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...registry, next: { ...registry.synthetic, name: 'Next' } }), { status: 200 }))
        .mockRejectedValueOnce(new Error('Synthetic directory unavailable'))
    vi.stubGlobal('fetch', fetchMetadata)
    try {
        await fixture.runtime.command({ type: 'model-catalog' }); expect(fetchMetadata).not.toHaveBeenCalled()
        now.mockReturnValue(clock + 7 * 3_600_000)
        const [first, second] = await Promise.all([fixture.runtime.command({ type: 'model-catalog' }), fixture.runtime.command({ type: 'model-catalog' })]) as ModelCatalogView[]
        expect(first!.providers.map(provider => provider.id)).toContain('next'); expect(second!.cached).toBe(true)
        expect(fetchMetadata).toHaveBeenCalledTimes(1)
        const saved = await readFile(join(fixture.root, 'models.json'), 'utf8')
        now.mockReturnValue(clock + 14 * 3_600_000)
        expect((await fixture.runtime.command({ type: 'model-catalog' }) as ModelCatalogView).providers.map(provider => provider.id)).toContain('next')
        expect(await readFile(join(fixture.root, 'models.json'), 'utf8')).toBe(saved)
        await fixture.runtime.command({ type: 'model-catalog' }); expect(fetchMetadata).toHaveBeenCalledTimes(2)
    } finally { now.mockRestore(); vi.unstubAllGlobals(); await fixture.close() }
})
