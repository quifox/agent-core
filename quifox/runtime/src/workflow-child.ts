import vm from 'node:vm'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

/** Compiled Bun applications re-exec themselves and load the generated workflow cell. */
export async function workflowChild(path: string): Promise<void> {
    const entry = await import(pathToFileURL(path).href) as { start(deps: unknown): Promise<void> }
    await entry.start({ vm, createInterface, stdin: process.stdin, stdout: process.stdout })
}
