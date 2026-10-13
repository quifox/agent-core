import { useRef, type ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as Collapsible from '@radix-ui/react-collapsible'
import * as Tooltip from '@radix-ui/react-tooltip'

export const DialogTitle = DialogPrimitive.Title

/** All application dialogs share focus containment, Escape and focus restoration. */
export function Dialog({ children, label, close }: { children: ReactNode; label: string; close(): void }) {
    const previous = useRef(document.activeElement)
    return <DialogPrimitive.Root open onOpenChange={open => { if (!open) close() }}>
        <DialogPrimitive.Portal container={document.querySelector<HTMLElement>('.app-shell')}>
            <DialogPrimitive.Overlay className="dialog-overlay"/>
            <DialogPrimitive.Content className="dialog-shell" aria-labelledby={label} aria-describedby={undefined}
                onOpenAutoFocus={event => { const first = document.getElementById(label)?.closest('.dialog-shell')?.querySelector<HTMLElement>('input, select, textarea'); if (first) { event.preventDefault(); first.focus() } }}
                onCloseAutoFocus={event => { event.preventDefault(); if (previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus() }}>
                {children}
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
}

export function EmptyState({ title, description, action }: { title: string; description?: string | undefined; action?: ReactNode }) {
    return <section className="empty-state" aria-label={title}><div className="empty-state-mark" aria-hidden="true">◇</div><strong>{title}</strong>
        {description && <div className="empty-state-description">{description}</div>}{action && <div className="empty-state-action">{action}</div>}</section>
}

export function StatusMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
    return <div className={error ? 'status-message error' : 'status-message'} role={error ? 'alert' : 'status'}>{children}</div>
}

export function FieldHint({ children }: { children: ReactNode }) {
    return <div className="field-hint">{children}</div>
}

export function SectionDescription({ children }: { children: ReactNode }) {
    return <div className="section-description">{children}</div>
}

export function SettingSwitch({ label, checked, onCheckedChange, disabled = false, labelHidden = false }: {
    label: string; checked: boolean; onCheckedChange(checked: boolean): void; disabled?: boolean; labelHidden?: boolean
}) {
    return <label className="switch-row"><span className={labelHidden ? 'sr-only' : undefined}>{label}</span><SwitchPrimitive.Root className="switch" checked={checked} disabled={disabled}
        onCheckedChange={onCheckedChange} aria-label={label}><SwitchPrimitive.Thumb className="switch-thumb"/></SwitchPrimitive.Root></label>
}

export function Disclosure({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
    return <Collapsible.Root className="disclosure" defaultOpen={defaultOpen}><Collapsible.Trigger className="disclosure-trigger">
        <span>{title}</span><span aria-hidden="true">⌄</span></Collapsible.Trigger><Collapsible.Content className="disclosure-content">{children}</Collapsible.Content></Collapsible.Root>
}

export function HintTooltip({ label, children }: { label: string; children: ReactNode }) {
    return <Tooltip.Provider delayDuration={250}><Tooltip.Root><Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={7}>{label}<Tooltip.Arrow className="tooltip-arrow"/></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root></Tooltip.Provider>
}
