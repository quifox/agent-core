import { expect, it, vi } from 'vitest'
import { createAgent, ToolRegistry, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin } from '@quifox/agent-plugin-session'
import { ContextualChatConversationPlugin, RequestContextPlugin } from '@quifox/agent-plugin-request-context'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { ProjectGuidancePlugin, SkillsPlugin } from '../src/index.js'

it('loads only metadata initially and the selected skill body through the ordinary tool loop', async () => {
    const requests: ModelRequest[] = []
    const read = vi.fn(async () => '---\nname: code-review\ndescription: Review changes.\n---\nCHECK THE ORIGINAL REQUIREMENT')
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'o' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
            yield { type: 'tool-call', call: { id: 'load', name: 'skill_load', input: { skill: 'code-review' } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
    } }) })
    const skills = new SkillsPlugin({ roots: ['project'], files: {
        list: async () => ['code-review'], metadata: async () => 'name: code-review\ndescription: Review changes.', read
    }, context: () => context })
    const conversation = new ContextualChatConversationPlugin({ session, context, generation })
    expect((await createAgent({ plugins: [conversation, skills] }).run({ prompt: 'Review the work' })).ok).toBe(true)
    expect(JSON.stringify(requests[0])).toContain('Review changes.')
    expect(JSON.stringify(requests[0])).not.toContain('CHECK THE ORIGINAL')
    expect(JSON.stringify(requests[1])).toContain('CHECK THE ORIGINAL')
    expect(read).toHaveBeenCalledExactlyOnceWith('project', 'code-review/SKILL.md')
    expect(session.messages.filter(message => message.role === 'system')).toHaveLength(0)
})

it('loads ordered ancestor guidance with same-scope override and excludes sibling scopes', async () => {
    const documents: Record<string, string> = {
        'global/AGENTS.md': 'Global instructions', 'repo/AGENTS.md': 'Default repo instructions',
        'repo/AGENTS.override.md': 'Repo override', 'child/AGENTS.override.md': '   ',
        'child/AGENTS.md': 'Child instructions', 'sibling/AGENTS.md': 'Wrong sibling'
    }
    const read = vi.fn(async (root: string, path: string) => documents[`${root}/${path}`])
    const plugin = new ProjectGuidancePlugin({ scopes: ['global', 'repo', 'child'],
        files: { read, list: async () => [], metadata: async () => undefined }, context: () => ({ set: () => {} }) })
    expect(await plugin.load()).toEqual([
        { root: 'global', path: 'AGENTS.md', content: 'Global instructions' },
        { root: 'repo', path: 'AGENTS.override.md', content: 'Repo override' },
        { root: 'child', path: 'AGENTS.md', content: 'Child instructions' }
    ])
    expect(read.mock.calls.some(([root]) => root === 'sibling')).toBe(false)
    expect(read).not.toHaveBeenCalledWith('repo', 'AGENTS.md')
})

it('an explicit Host selection loads instructions into temporary request context', async () => {
    const requests: ModelRequest[] = []
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'o' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(request); yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const skills = new SkillsPlugin({ roots: ['project'], files: { list: async () => ['code-review'],
        metadata: async () => 'name: code-review\ndescription: Review changes.', read: async () => 'EXPLICIT SKILL INSTRUCTIONS' },
        context: () => context, selected: () => ['code-review'] })
    const conversation = new ContextualChatConversationPlugin({ session, context, generation })
    expect((await createAgent({ plugins: [conversation, skills] }).run({ prompt: 'Review' })).ok).toBe(true)
    expect(JSON.stringify(requests[0])).toContain('EXPLICIT SKILL INSTRUCTIONS')
    expect(JSON.stringify(session.snapshot())).not.toContain('EXPLICIT SKILL INSTRUCTIONS')
})

it.each(['../other.md', '/etc/file', 'references/../../other', 'references\\file', 'a//b', 'a/./b', 'file:/x', '%2e%2e/file'])('rejects escaped resource %s before file I/O', async path => {
    const read = vi.fn(async () => 'body')
    const skills = new SkillsPlugin({ roots: ['project'], files: { list: async () => ['valid'], metadata: async () => 'name: valid\ndescription: Valid skill.', read }, context: () => ({ set: () => {} }) })
    const ctx = { tools: new ToolRegistry(), plugins: [] }
    await skills.load(ctx, 'valid')
    read.mockClear()
    expect((await skills.read(ctx, 'valid', path)).code).toBe('SKILL_PATH_INVALID')
    expect(read).not.toHaveBeenCalled()
})

it('keeps resource activation isolated across Agents and reports invalid metadata', async () => {
    const skills = new SkillsPlugin({ roots: ['project'], files: { list: async () => ['valid', 'invalid'], metadata: async (_root, path) => path.startsWith('valid/')
        ? 'name: valid\ndescription: Valid skill.' : 'name: invalid\nname: duplicate\ndescription: Duplicate key.', read: async () => 'resource' }, context: () => ({ set: () => {} }) })
    const one = { tools: new ToolRegistry(), plugins: [] }
    const two = { tools: new ToolRegistry(), plugins: [] }
    expect((await skills.catalog()).issues).toHaveLength(1)
    await skills.load(one, 'valid')
    expect((await skills.read(two, 'valid', 'references/guide.md')).code).toBe('SKILL_NOT_LOADED')
    expect((await skills.read(one, 'valid', 'references/guide.md')).content).toBe('resource')
})
