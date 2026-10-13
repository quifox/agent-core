import { expect, it } from 'vitest'
import { inputSuggestions } from '../src/input-routing.js'

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
