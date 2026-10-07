import type { z } from 'zod'

import type { AgentHooks } from './hooks.js'
import type { AgentContext } from './context.js'
import type { AgentTool } from './tools.js'

/** 注册、实例初始化与 Run 使用同一组显式 Hook 合同。 */
type PluginHooks<Input, Ctx extends AgentContext> = AgentHooks<Input, Ctx>
type HookName = keyof AgentHooks

/** 方法装饰器仅保存定义工厂；执行仍由现有 Registry/Executor/HookRunner 负责。 */
interface MethodDeclaration {
    readonly key: string | symbol
    readonly hook?: HookName
    readonly bind: (instance: object) => unknown
}

const toolDeclarations = new WeakMap<object, MethodDeclaration[]>()
const hookDeclarations = new WeakMap<object, MethodDeclaration[]>()

type HookHandler<Name extends HookName, Input, Ctx extends AgentContext> = Extract<
    NonNullable<PluginHooks<Input, Ctx>[Name]>, (...args: never[]) => unknown
>

/**
 * 标注工具实例方法；Schema 输出类型约束业务方法的输入。
 *
 * 使用 https://www.typescriptlang.org/docs/handbook/decorators.html 的 experimentalDecorators，
 * 不依赖 reflect-metadata 或自动实例化。
 * @param definition - 不包含 execute 的既有 Tool 定义。
 * @returns TypeScript 方法装饰器。
 */
export function Tool<Schema extends z.ZodType, TData = unknown, TContext extends AgentContext = AgentContext>(
    definition: Omit<AgentTool<Schema, TData, TContext>, 'execute' | 'prepare'> &
        { prepare?: AgentTool<Schema, TData, TContext>['prepare'] }
) {
    return (target: object, key: string | symbol, descriptor: Pick<TypedPropertyDescriptor<AgentTool<Schema, TData, TContext>['execute']>, 'value'>): void => {
        const method = descriptor.value
        if (typeof target === 'function' || typeof method !== 'function') {
            throw new Error('Tool decorator requires an instance method')
        }
        declareMethod(toolDeclarations, target, {
            key,
            bind: instance => ({ ...definition,
                prepare: definition.prepare ?? (async (_ctx: TContext, raw: unknown) => definition.inputSchema.parseAsync(raw)),
                execute: method.bind(instance) })
        })
    }
}

/**
 * 标注对应生命周期的实例方法；参数和返回值遵守原 Hook 合同。
 * @param name - 注册准备、一次性初始化或 Run 的函数生命周期名称。
 * @returns TypeScript 方法装饰器。
 */
export function Hook<Name extends HookName>(name: Name) {
    return <Input, Ctx extends AgentContext>(target: object, key: string | symbol, descriptor: Pick<TypedPropertyDescriptor<HookHandler<Name, Input, Ctx>>, 'value'>): void => {
        const method = descriptor.value
        if (typeof target === 'function' || typeof method !== 'function') {
            throw new Error('Hook decorator requires an instance method')
        }
        declareMethod(hookDeclarations, target, {
            key, hook: name, bind: instance => method.bind(instance)
        })
    }
}

/**
 * 按声明顺序收集实例的工具，生成普通 AgentTool 列表。
 * @param instance - 由宿主显式创建的工具实例。
 * @returns 不包含第二执行路径的实例绑定定义。
 */
export function toolsFrom<TContext extends AgentContext = AgentContext>(instance: object): AgentTool<z.ZodType, unknown, TContext>[] {
    return declarationsFor(toolDeclarations, instance).map(item => item.bind(instance)) as AgentTool<z.ZodType, unknown, TContext>[]
}

/**
 * 收集实例钩子；同一生命周期按方法声明顺序执行。
 * @param instance - 由宿主显式创建的钩子实例。
 * @returns 直接交给 Agent 的既有 Hook 合同。
 */
export function hooksFrom<Input = unknown, Ctx extends AgentContext = AgentContext>(instance: object): PluginHooks<Input, Ctx> {
    const hooks: Record<string, unknown[]> = {}
    for (const declaration of declarationsFor(hookDeclarations, instance)) {
        const name = declaration.hook
        if (name === undefined) { throw new Error('Missing Hook lifecycle') }
        ;(hooks[name] ??= []).push(declaration.bind(instance))
    }
    if (hooks.model) {
        if (hooks.model.length !== 1) { throw new Error('只能声明一个 model 方法。') }
        return { ...hooks, model: hooks.model[0] } as PluginHooks<Input, Ctx>
    }
    return hooks as PluginHooks<Input, Ctx>
}

/**
 * 记录直属原型的方法声明，不改变方法本身。
 * @param store - 声明种类对应的弱引用存储。
 * @param target - 方法所属原型。
 * @param declaration - 带实例绑定工厂的声明。
 */
function declareMethod(store: WeakMap<object, MethodDeclaration[]>, target: object, declaration: MethodDeclaration): void {
    const declarations = store.get(target) ?? []
    if (declarations.some(item => item.key === declaration.key)) {
        throw new Error('A method can have only one decorator of each kind')
    }
    declarations.push(declaration)
    store.set(target, declarations)
}

/**
 * 收集原型链声明；子类显式重标注同名方法时覆盖父类定义。
 * @param store - 工具或钩子的声明存储。
 * @param instance - 已创建的实例。
 * @returns 按父类到子类声明顺序排列的元数据。
 */
function declarationsFor(store: WeakMap<object, MethodDeclaration[]>, instance: object): MethodDeclaration[] {
    const prototypes: object[] = []
    for (let prototype: object | null = Object.getPrototypeOf(instance); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
        prototypes.unshift(prototype)
    }
    const declarations = new Map<string | symbol, MethodDeclaration>()
    for (const prototype of prototypes) {
        for (const declaration of store.get(prototype) ?? []) {
            declarations.set(declaration.key, declaration)
        }
    }
    return [...declarations.values()]
}
