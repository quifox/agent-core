// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SelectMenu } from '../src/select-menu.js'

afterEach(cleanup)
it('filters the menu, selects with the keyboard, restores focus and dismisses with Escape', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    function Example() {
        const [value, setValue] = useState('low')
        return <SelectMenu label="强度" value={value} onChange={setValue} searchable options={['low', 'high', 'max'].map(value => ({ value, label: value }))}/>
    }
    const user = userEvent.setup(); render(<Example/>)
    const button = screen.getByRole('combobox', { name: '强度' })
    await user.click(button); const search = screen.getByRole('combobox', { name: '筛选强度' }); await user.type(search, 'hi')
    expect(search.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'high' }).id)
    await user.keyboard('{Enter}')
    expect(button.textContent).toContain('high'); expect(document.activeElement).toBe(button)
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}'); expect(button.textContent).toContain('max')
    await user.click(button); await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull(); expect(document.activeElement).toBe(button)
})

it('focuses a select-only trigger opened through an accessibility click so Escape can dismiss it', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const user = userEvent.setup()
    render(<SelectMenu label="强度" value="high" onChange={() => {}} options={[{ value: 'high', label: 'high' }]}/>)
    const button = screen.getByRole('combobox', { name: '强度' })
    fireEvent.click(button)
    expect(document.activeElement).toBe(button)
    await user.keyboard('{Escape}'); expect(screen.queryByRole('listbox')).toBeNull()
})
