import { expect, test } from '@playwright/test'
import { inspectWorkflow } from '../../runtime/dist/workflow.js'

const script = '/** @phase Intent */\nasync function intent(){ return await agent("Intent").ask(String(args.question)); }\n/** @phase Evidence */\nasync function research(query:string){ const results = await Promise.all([agent("Facts").ask(query), agent("Check").ask(query)]); return results.join("\\n"); }\n/** @phase Answer */\nasync function answer(evidence:string){ return await agent("Answer").ask(evidence); }\nconst query = await intent(); if(query === "greeting") return "Hello"; return await answer(await research(query));'
const workflowDocument = { name: 'knowledge', script, inspection: inspectWorkflow(script) }

test('workflow library shows analyzed branches and reuses multi-turn chat at wide and narrow widths', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document), workflowDocument)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'knowledge' }).click()
    await expect(page.getByRole('region', { name: '工作流图' })).toBeVisible()
    await expect(page.locator('.react-flow__edge')).not.toHaveCount(0)
    const viewport = page.locator('.react-flow__viewport')
    const before = await viewport.getAttribute('style')
    await page.getByRole('button', { name: '放大工作流图' }).click()
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(before)
    await page.getByRole('button', { name: '适合工作流视图' }).click()
    const canvas = await page.locator('.react-flow').boundingBox(), beforePan = await viewport.getAttribute('style')
    await page.mouse.move(canvas!.x + 12, canvas!.y + 30); await page.mouse.down(); await page.mouse.move(canvas!.x + 70, canvas!.y + 70); await page.mouse.up()
    await expect.poll(() => viewport.getAttribute('style')).not.toBe(beforePan)
    await page.getByRole('button', { name: '适合工作流视图' }).click()
    await expect(page.getByRole('button', { name: '调用实例' })).toBeDisabled()
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0)
    expect(await page.locator('.react-flow__edge-path').evaluateAll(paths => paths.every(path => !/NaN|undefined/.test(path.getAttribute('d') ?? '')))).toBe(true)
    await page.getByRole('textbox', { name: '给 quifox 的消息' }).fill('一个通用的知识问题')
    await page.getByRole('button', { name: '发送消息' }).click()
    await expect(page.getByText('有来源的测试回答', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && scrollX === 0)).toBe(true)
    await page.screenshot({ path: '../../artifacts/ui/workflow-wide.png' })
    await page.setViewportSize({ width: 760, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.getByRole('textbox', { name: '给 quifox 的消息' })).toBeVisible()
    await page.screenshot({ path: '../../artifacts/ui/workflow-narrow.png' })
    expect(errors).toEqual([])
})

test('actual node facts highlight completed and active phases while untouched paths stay muted', async ({ page }) => {
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document), workflowDocument)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'knowledge' }).click()
    await page.evaluate(() => window.uiFixture.workflowState())
    await expect(page.locator('.workflow-state-running')).not.toHaveCount(0)
    await expect(page.locator('.workflow-state-completed')).not.toHaveCount(0)
    await expect(page.locator('.workflow-state-idle')).not.toHaveCount(0)
    await expect(page.locator('.workflow-edge-observed')).not.toHaveCount(0)
    expect(await page.locator('.workflow-edge-observed .react-flow__edge-path').evaluateAll(paths => paths.every(path => getComputedStyle(path).strokeDasharray === 'none'))).toBe(true)
    await page.getByRole('button', { name: '调用实例' }).click()
    await expect(page.locator('.react-flow__node')).toHaveCount(3)
    await page.locator('.react-flow__node').first().getByRole('button').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel('节点调用详情')).toBeVisible()
    await page.getByRole('button', { name: '关闭节点详情' }).click()
    await page.getByRole('button', { name: '调用关系' }).click()
    await page.screenshot({ path: '../../artifacts/ui/workflow-highlight.png' })
})

test('shared methods and recursive relations keep nodes and routed paths separate', async ({ page }) => {
    const branching = '/** @node Root */\nfunction root(){return first()+second();}\n/** @node First */\nfunction first(){return shared(1);}\n/** @node Second */\nfunction second(){return shared(2);}\n/** @node Shared */\nfunction shared(depth:number):string{if(depth>0)return shared(depth-1);return "done";}\nreturn root();'
    const document = { name: 'branching', script: branching, inspection: inspectWorkflow(branching) }
    expect(document.inspection.ok).toBe(true)
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document), document)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'branching' }).click()
    await expect(page.locator('.react-flow__node')).toHaveCount(5)
    const overlaps = await page.locator('.react-flow').evaluate(canvas => {
        const rectangles = [...canvas.querySelectorAll('.react-flow__node')].map(node => node.getBoundingClientRect())
        return rectangles.some((a, index) => rectangles.slice(index + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
    })
    expect(overlaps).toBe(false)
    const crossings = await page.locator('.react-flow').evaluate(canvas => {
        const rectangles = [...canvas.querySelectorAll('.react-flow__node')].map(node => ({ id: node.getAttribute('data-id'), rect: node.getBoundingClientRect() }))
        return [...canvas.querySelectorAll<SVGPathElement>('.react-flow__edge-path')].flatMap(path => {
            const matrix = path.getScreenCTM()!, length = path.getTotalLength()
            for (let distance = 8; distance < length - 8; distance += 8) {
                const point = path.getPointAtLength(distance), position = new DOMPoint(point.x, point.y).matrixTransform(matrix)
                const crossed = rectangles.find(({ rect }) => position.x > rect.left + 3 && position.x < rect.right - 3 && position.y > rect.top + 3 && position.y < rect.bottom - 3)
                if (crossed) return [{ edge: path.id, node: crossed.id, route: path.getAttribute('d') }]
            }
            return []
        })
    })
    expect(crossings).toEqual([])
    await page.screenshot({ path: '../../artifacts/ui/workflow-branches.png' })
})

test('recovered Session status closes stale active calls even without child settlement events', async ({ page }) => {
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document), workflowDocument)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'knowledge' }).click()
    await page.evaluate(() => window.uiFixture.workflowState())
    await expect(page.locator('.workflow-state-running')).not.toHaveCount(0)
    await page.evaluate(() => window.uiFixture.workflowInterrupted())
    await expect(page.locator('.workflow-state-running')).toHaveCount(0)
    await expect(page.locator('.workflow-state-cancelled')).not.toHaveCount(0)
    await expect(page.locator('.workflow-state-completed')).not.toHaveCount(0)
    await expect(page.getByRole('region', { name: '工作流图' }).getByText('已中断')).not.toHaveCount(0)
})

test('closing API management preserves the service and provides a real stop action after navigating away', async ({ page }) => {
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document), workflowDocument)
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'knowledge' }).click()
    await page.getByRole('button', { name: '部署为本地 API' }).click()
    await expect(page.getByRole('dialog', { name: '工作流本地 API' })).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('navigation', { name: '已保存工作流' }).getByRole('button', { name: 'knowledge' }).click()
    await page.getByRole('button', { name: '管理本地 API' }).click()
    await expect(page.getByLabel('接口地址')).toHaveValue('http://127.0.0.1:12345')
    await page.getByRole('button', { name: '停止 API' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '部署为本地 API' })).toBeVisible()
})

test('dynamic-workflow code renders a graph card and opens the right test panel', async ({ page }) => {
    await page.goto('/e2e/harness.html')
    await page.evaluate(document => window.uiFixture.workflow(document, true), workflowDocument)
    await page.getByRole('button', { name: '界面验收', exact: true }).click()
    await expect(page.locator('.workflow-card')).toBeVisible()
    await page.locator('.workflow-card').getByRole('button', { name: '运行', exact: true }).click()
    await expect(page.getByRole('complementary', { name: '工作流测试' })).toBeVisible()
    await page.getByRole('textbox', { name: '工作流测试输入' }).fill('继续追问')
    await page.getByRole('button', { name: '发送工作流输入' }).click()
    await expect(page.getByRole('complementary', { name: '工作流测试' }).getByText('有来源的测试回答', { exact: true })).toBeVisible()
    await page.screenshot({ path: '../../artifacts/ui/workflow-inline.png' })
})
