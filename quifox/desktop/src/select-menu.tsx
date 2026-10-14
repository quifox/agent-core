import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from './icons.js'
import { EmptyState } from './ui.js'

/** A neutral, keyboard-operable menu shared by the composer and settings. */
export function SelectMenu({ label, value, options, onChange, disabled = false, searchable = false, above = false }: {
    label: string; value: string; options: readonly { value: string; label: string; description?: string }[]; onChange(value: string): void
    disabled?: boolean; searchable?: boolean; above?: boolean
}) {
    const id = useId(), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), search = useRef<HTMLInputElement>(null)
    const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0)
    const filtered = options.filter(option => `${option.label} ${option.description ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    const show = (): void => { button.current?.focus(); setQuery(''); setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true) }
    const close = (): void => { setOpen(false); button.current?.focus() }
    const choose = (next: string): void => { onChange(next); close() }
    useEffect(() => {
        if (!open) return
        if (searchable) search.current?.focus()
        const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
    }, [open, searchable])
    useEffect(() => { if (open) root.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [open, active, query])
    return <div className={`select-menu${above ? ' above' : ''}`} ref={root} onKeyDown={event => {
        if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close() }
        else if (event.key === 'Tab') setOpen(false)
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) show(); else setActive(index => filtered.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length : 0)
        } else if (event.key === 'Enter' && open) { event.preventDefault(); if (filtered[active]) choose(filtered[active].value) }
    }}>
        <button ref={button} type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-activedescendant={open && filtered[active] ? `${id}-${active}` : undefined} disabled={disabled} onClick={() => open ? close() : show()}>
            <span>{options.find(option => option.value === value)?.label ?? value}</span><Icon name="down"/>
        </button>
        {open && <div className="select-popover">{searchable && <input ref={search} role="combobox" aria-label={`筛选${label}`} aria-autocomplete="list" aria-expanded={open} aria-controls={id} aria-activedescendant={filtered[active] ? `${id}-${active}` : undefined} placeholder="搜索…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }}/>}<div id={id} role="listbox" aria-label={label}>
            {filtered.map((option, index) => <button id={`${id}-${index}`} type="button" role="option" aria-selected={option.value === value} data-active={active === index} key={option.value} onPointerMove={() => setActive(index)} onClick={() => choose(option.value)}><span><span>{option.label}</span>{option.description && <small className="option-description">{option.description}</small>}</span>{option.value === value && <span aria-hidden="true">✓</span>}</button>)}
            {!filtered.length && <EmptyState title="没有匹配项"/>}
        </div></div>}
    </div>
}
