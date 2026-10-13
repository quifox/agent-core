import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/e2e/harness.html'); await page.getByRole('button', { name: '界面验收', exact: true }).click() })

test('stream handoff preserves output and reasoning precedes the body', async ({ page }) => {
    await page.evaluate(() => window.uiFixture.stream())
    await expect(page.getByText('流式回复持续可见')).toBeVisible()
    await page.evaluate(() => window.uiFixture.commit())
    await expect(page.getByText('流式回复持续可见')).toHaveCount(1)
    expect(await page.locator('.message-body').evaluate(node => node.firstElementChild?.className)).toBe('reasoning')
    await page.screenshot({ path: '../../artifacts/ui/conversation.png' })
})

test('queue deletion and prefix guidance share one pause/resume control', async ({ page }) => {
    await page.evaluate(() => window.uiFixture.running())
    const input = page.getByRole('textbox', { name: '给 quifox 的消息' })
    for (const message of ['第一个指引', '第二个指引', '第三个指引']) { await input.fill(message); await page.getByRole('button', { name: '发送消息' }).click() }
    await expect(page.getByText('3 条消息排队中')).toBeVisible()
    await page.getByRole('button', { name: '删除排队消息：第三个指引' }).click()
    await expect(page.getByText('2 条消息排队中')).toBeVisible()
    await page.getByRole('button', { name: '引导消息：第二个指引' }).click()
    await expect(page.locator('.pending-queue')).toHaveCount(0)
    await expect(page.locator('.message.user')).toHaveCount(2)
    await page.getByRole('button', { name: '暂停执行' }).click()
    await expect(page.getByRole('button', { name: '恢复执行' })).toBeVisible()
    await expect(page.getByRole('button', { name: '重新规划' })).toHaveCount(0)
    await page.getByRole('button', { name: '恢复执行' }).click()
    await expect(page.getByRole('button', { name: '暂停执行' })).toBeVisible()
})

test('active zoom persists, settings use one navigation and dialogs contain focus', async ({ page }) => {
    await page.evaluate(() => window.uiFixture.running())
    await page.keyboard.press('Control+=')
    await expect(page.locator('.app-shell')).toHaveCSS('zoom', '1.1')
    await page.getByRole('button', { name: '打开设置' }).click()
    await page.getByRole('button', { name: '外观', exact: true }).click()
    await expect(page.getByRole('button', { name: '返回对话', exact: true })).toHaveCount(0)
    await expect(page.locator('.app-shell')).toHaveCSS('zoom', '1.1')
    await page.screenshot({ path: '../../artifacts/ui/appearance.png' })
    await page.getByRole('button', { name: '模型', exact: true }).click()
    const trigger = page.getByRole('button', { name: '编辑默认连接' })
    await trigger.click(); const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    for (let index = 0; index < 25; index++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true) }
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused()
})

test('approval and composer align across wide and narrow viewports', async ({ page }) => {
    await page.evaluate(() => { window.uiFixture.commit(); window.uiFixture.approval() })
    for (const width of [1440, 700]) {
        await page.setViewportSize({ width, height: 900 })
        const approval = await page.locator('.approval-card').boundingBox(), composer = await page.locator('.composer-wrap').boundingBox()
        expect(approval).not.toBeNull(); expect(composer).not.toBeNull()
        expect(Math.abs(approval!.x - composer!.x)).toBeLessThan(2)
        expect(Math.abs(approval!.width - composer!.width)).toBeLessThan(2)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
})

test('observation session list and long trajectory scroll without duplicate navigation', async ({ page }) => {
    await page.evaluate(() => window.uiFixture.trace())
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '查看运行观察' }).click()
    await expect(page.getByRole('heading', { name: '选择观察会话' })).toBeVisible()
    await page.getByRole('button', { name: '观察界面验收' }).click()
    await expect(page.getByRole('heading', { name: '运行观测' })).toBeVisible()
    const scrolling = page.locator('.observation-browser')
    await expect.poll(() => scrolling.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true)
    await scrolling.evaluate(node => { node.scrollTop = node.scrollHeight })
    expect(await scrolling.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
    await page.screenshot({ path: '../../artifacts/ui/observability.png' })
})
