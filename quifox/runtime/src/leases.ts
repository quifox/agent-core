import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'

const options = { realpath: false, stale: 10_000, update: 2_000 } as const
interface Lease { release(): Promise<void>; assert(): void }

/** Cross-process leases use mkdir and a heartbeat; a lost lease fails closed before the next write. */
export async function acquireLease(path: string, wait = false): Promise<Lease> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    let compromised: Error | undefined
    const release = await lockfile.lock(path, { ...options,
        retries: wait ? { retries: 150, minTimeout: 100, maxTimeout: 100, factor: 1 } : 0,
        onCompromised: error => { compromised = error } })
    return { assert: () => { if (compromised) throw new Error('持久化租约已失效，请重新打开会话。', { cause: compromised }) },
        release: async () => { if (!compromised) await release() } }
}

export async function leaseBusy(path: string): Promise<boolean> { return lockfile.check(path, options) }

const queues = new Map<string, Promise<unknown>>()
/** Short shared-resource transactions also serialize callers in the same process. */
export async function withFileLease<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const work = (queues.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const lease = await acquireLease(path, true)
        try { lease.assert(); return await operation() } finally { await lease.release() }
    })
    queues.set(path, work)
    try { return await work } finally { if (queues.get(path) === work) queues.delete(path) }
}

export class SessionLeases {
    private readonly held = new Map<string, Lease>()
    private readonly pending = new Map<string, Promise<void>>()
    has(path: string): boolean { return this.held.has(path) }
    assert(path: string): void { const lease = this.held.get(path); if (!lease) throw new Error('会话没有执行租约。'); lease.assert() }
    async claim(path: string): Promise<void> {
        if (this.held.has(path)) { this.assert(path); return }
        if (this.pending.has(path)) return this.pending.get(path)
        const work = acquireLease(path).then(lease => { this.held.set(path, lease) }, error => {
            if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new Error('此会话正由另一个宿主使用；可新建会话或等待该宿主退出。')
            throw error
        })
        this.pending.set(path, work)
        try { await work } finally { this.pending.delete(path) }
    }
    async release(path: string): Promise<void> { const lease = this.held.get(path); this.held.delete(path); await lease?.release() }
    async close(): Promise<void> { await Promise.allSettled(this.pending.values()); await Promise.all([...this.held.keys()].map(path => this.release(path))) }
}
