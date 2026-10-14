import { expect, it } from 'vitest'
import { inputSuggestions, parseSpawnInput } from '../src/input-routing.js'

it('parses empty-history spawn by default and only forks with an explicit flag', () => {
    expect(parseSpawnInput('/spawn 2 assigned task')).toEqual({ count: 2, mode: 'empty', instructions: 'assigned task' })
    expect(parseSpawnInput('/spawn --fork 2 preserve plan')).toEqual({ count: 2, mode: 'fork', instructions: 'preserve plan' })
    expect(parseSpawnInput('/spawn --fork')).toEqual({ count: 1, mode: 'fork' })
    expect(parseSpawnInput('/spawn')).toEqual({ count: 1, mode: 'empty' })
})

it('suggests commands and exact skill identities with shared replacement ranges', () => {
    const skills = [{ id: 'global/review', name: 'review', description: 'Review source' }, { id: 'project/review', name: 'review', description: 'Project review' }]
    const commands = [{ name: '/spawn', description: 'Create standby Agents' }]
    expect(inputSuggestions('/', 1, { skills, commands }).map(item => item.label)).toEqual(['/spawn', '/review'])
    expect(inputSuggestions('$re', 3, { skills, commands })).toEqual([
        expect.objectContaining({ label: '$review', kind: 'skill', start: 0, end: 3, text: '$project/review ' })
    ])
    expect(inputSuggestions('please $re', 10, { skills, commands })).toEqual([])
    expect(inputSuggestions('/spawn 3', 8, { skills, commands })).toEqual([])
    expect(inputSuggestions('email@Tu', 8, { agents: [{ name: 'Turing', sessionId: 'child', taskId: 'task', status: 'idle' }] })).toEqual([])
})
