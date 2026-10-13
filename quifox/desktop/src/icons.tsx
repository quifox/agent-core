import type { ReactNode } from 'react'

const paths = {
    pause: <path d="M8 5v14M16 5v14"/>,
    play: <path d="m8 5 11 7-11 7V5Z"/>,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
    restore: <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>,
    changes: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8m-4-3v6m-4 5h8"/></>,
    external: <path d="M14 3h7v7m0-7L10 14M9 5H3v16h16v-6"/>,
    collapse: <path d="M4 4h16M4 20h16m-8-3V7m-3 3 3-3 3 3m-6 4 3 3 3-3"/>,
    wrap: <path d="M3 6h18M3 11h14a4 4 0 0 1 0 8h-4m3-3-3 3 3 3M3 16h5"/>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 6-5 4 4 3-3 5 5"/></>,
    video: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4V8Z"/></>,
    chevron: <path d="m9 5 7 7-7 7"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    navigation: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
    plugins: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    settings: <><path d="m10 3-1 3-3 1-3 3 2 3v4l4 1 3 3 3-2 4-1 1-4 2-3-3-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
    folder: <path d="M3 7h7l2 2h9v10H3V7Zm0 0V5h7l2 2"/>,
    left: <path d="m10 5-7 7 7 7M3 12h18"/>,
    right: <path d="m14 5 7 7-7 7M3 12h18"/>,
    down: <path d="m6 9 6 6 6-6"/>,
    up: <path d="m6 10 6-6 6 6M12 4v16"/>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    model: <><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/></>,
    appearance: <><circle cx="12" cy="12" r="9"/><path d="M12 3v18M12 7h6m-6 5h9m-9 5h6"/></>,
    interaction: <path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>,
    shield: <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6"/>,
    agents: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 5a5 5 0 0 1 3 4v2"/></>,
    skills: <path d="m13 2-9 12h7l-1 8 10-13h-7l0-7Z"/>,
    file: <path d="M5 3h9l5 5v13H5V3Zm9 0v5h5M9 12h6m-6 4h6"/>,
    memory: <><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M8 1v4m8-4v4M8 19v4m8-4v4M8 9h8m-8 4h5"/></>,
    context: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    refresh: <path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/>
} satisfies Record<string, ReactNode>
export type IconName = keyof typeof paths
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
    return <svg className={`ui-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
