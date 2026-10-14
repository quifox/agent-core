import { expect, it } from 'vitest'
import { analyzeWorkflowScript } from '../src/index.js'
it('recognizes Host plugin personas and ordinary parallel TypeScript control flow', () => {
    const result = analyzeWorkflowScript('phase("Parallel"); const results = await Promise.all([agent("A", {plugins:["ragflow"], tools:["knowledge_retrieve"]}).ask("query"), agent("B").ask("check")]); return results.join("\\n");')
    expect(result.ok).toBe(true)
    expect(result.flow?.nodes.length).toBeGreaterThan(1)
    expect(result.causality?.steps.map(step => step.label)).toEqual(['A', 'B'])
    expect(result.causality?.edges).toEqual([])
})
