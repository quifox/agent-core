import ts from 'typescript'
import type { WorkflowProgram } from '@quifox/workflow-engine'
import type { WorkflowGraph } from './workflow.js'

type FunctionNode = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression

/** The checker resolves definitions; annotations provide labels, never authored edges. */
export function workflowCalls(program: WorkflowProgram) {
    const { scriptFile, toScriptLoc } = program, checker = program.program.getTypeChecker()
    const definitions = new Map<ts.Node, { id: string; async: boolean }>()
    const diagnostics: { line: number; column: number; message: string }[] = []
    const graph: WorkflowGraph = { nodes: [{ id: 'entry', label: '工作流入口', kind: 'function' }], edges: [] }
    const functions: FunctionNode[] = []
    const collect = (node: ts.Node): void => {
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
            if (ts.isFunctionDeclaration(node) && node.name?.text === '__workflowScript__') { ts.forEachChild(node, collect); return }
            const named = node.name ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined)
            const tag = ts.getJSDocTags(node).find(tag => tag.tagName.text === 'node' || tag.tagName.text === 'phase')
            if (named && !tag) diagnostics.push({ ...toScriptLoc(node.getStart(scriptFile)), message: '工作流方法必须使用 JSDoc @node 标签；@phase 也可作为节点标签。' })
            if (tag) {
                const location = toScriptLoc(node.getStart(scriptFile)), id = `function:${location.line}:${location.column}`
                if ('asteriskToken' in node && node.asteriskToken) diagnostics.push({ ...location, message: '工作流节点不支持生成器；请使用普通或 async 方法。' })
                const label = typeof tag.comment === 'string' && tag.comment.trim() ? tag.comment.trim() : named?.getText(scriptFile) ?? '节点'
                definitions.set(node, { id, async: !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) })
                functions.push(node)
                graph.nodes.push({ id, label, kind: 'function' })
            }
        }
        ts.forEachChild(node, collect)
    }
    collect(scriptFile)
    const owner = (node: ts.Node): string => {
        for (let parent = node.parent; parent; parent = parent.parent) { const definition = definitions.get(parent); if (definition) return definition.id }
        return 'entry'
    }
    const edge = (node: ts.Node, target: ts.Node, callback = false): void => {
        const definition = definitions.get(target)
        if (!definition) return
        const from = owner(node), to = definition.id
        let kind = callback ? 'callback' : 'call'
        for (let parent = node.parent; parent && !definitions.has(parent); parent = parent.parent) {
            if (ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) { kind = 'loop'; break }
            if (ts.isIfStatement(parent) || ts.isConditionalExpression(parent) || ts.isBinaryExpression(parent) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) kind = 'conditional'
        }
        if (!graph.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)) graph.edges.push({ from, to, kind })
    }
    const target = (expression: ts.Expression, seen = new Set<ts.Node>()): ts.Node | undefined => {
        if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return target(expression.expression, seen)
        if (definitions.has(expression)) return expression
        if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined
        const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression)
        for (const declaration of symbol?.declarations ?? []) {
            if (definitions.has(declaration)) return declaration
            if (seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) continue
            if (!ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) continue
            seen.add(declaration)
            const resolved = target(declaration.initializer, seen)
            if (resolved) return resolved
        }
        return undefined
    }
    const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            // A union's synthesized call signature can borrow its first declaration;
            // that is a type-checking result, not proof of a runtime dispatch target.
            const declaration = target(node.expression)
            if (declaration) edge(node, declaration)
            for (const argument of node.arguments) {
                const declaration = target(argument)
                if (declaration) edge(node, declaration, true)
            }
        }
        ts.forEachChild(node, walk)
    }
    walk(scriptFile)
    const bodies = new Map(functions.map(node => [node.body!, definitions.get(node)!]))
    return { graph, diagnostics, bodies }
}
