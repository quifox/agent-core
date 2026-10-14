import { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { StatusMessage } from './ui.js'

globalThis.MonacoEnvironment = { getWorker: (_id, label) => label === 'json' ? new JsonWorker() : label === 'css' || label === 'scss' || label === 'less' ? new CssWorker() : label === 'html' ? new HtmlWorker() : label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker() }
const languageOf = (path: string): string => {
    const extension = path.split('.').at(-1)?.toLowerCase()
    return ({ ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', rs: 'rust', py: 'python', cs: 'csharp', html: 'html', css: 'css', md: 'markdown', sh: 'shell', sql: 'sql', yml: 'yaml', yaml: 'yaml', toml: 'ini' } as Record<string, string>)[extension ?? ''] ?? 'plaintext'
}
interface Props { content: string; path: string; before?: string; theme: string; fontSize: number; find?: number; wrap?: boolean; sideBySide?: boolean; fold?: boolean }
export function CodeView({ content, path, before, theme, fontSize, find = 0, wrap = false, sideBySide = true, fold = true }: Props) {
    const element = useRef<HTMLDivElement>(null), editor = useRef<monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | undefined>(undefined), [error, setError] = useState<string>()
    useEffect(() => {
        if (!element.current) return
        const models: monaco.editor.ITextModel[] = []
        let current: typeof editor.current
        try {
            const options: monaco.editor.IStandaloneEditorConstructionOptions = { readOnly: true, domReadOnly: true, automaticLayout: true, minimap: { enabled: false }, fontSize,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollBeyondLastLine: false, lineNumbers: 'on', renderLineHighlight: 'none',
                padding: { top: 14, bottom: 16 }, wordWrap: wrap ? 'on' : 'off', links: false, stickyScroll: { enabled: false }, ariaLabel: `只读文件 ${path}` }
            const modified = monaco.editor.createModel(content, languageOf(path)); models.push(modified)
            if (before !== undefined) {
                const original = monaco.editor.createModel(before, languageOf(path)); models.push(original)
                current = monaco.editor.createDiffEditor(element.current, { ...options, renderSideBySide: sideBySide, useInlineViewWhenSpaceIsLimited: false, hideUnchangedRegions: { enabled: fold, contextLineCount: 3, minimumLineCount: 5, revealLineCount: 20 }, maxComputationTime: 1000 })
                current.setModel({ original, modified })
            } else {
                current = monaco.editor.create(element.current, { ...options, model: modified })
            }
            editor.current = current
        } catch { setError('阅读器加载失败；可在外部编辑器中查看。') }
        return () => { current?.dispose(); for (const model of models) model.dispose(); editor.current = undefined }
    }, [content, before, path])
    useEffect(() => {
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        const update = (): void => monaco.editor.setTheme(theme === 'dark' || (theme === 'system' && media.matches) ? 'vs-dark' : 'vs')
        update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update)
    }, [theme])
    useEffect(() => { editor.current?.updateOptions({ fontSize, wordWrap: wrap ? 'on' : 'off', ...before !== undefined ? { renderSideBySide: sideBySide, hideUnchangedRegions: { enabled: fold } } : {} }) }, [fontSize, wrap, sideBySide, fold, before])
    useEffect(() => {
        if (find && editor.current) {
            const current = editor.current, target = 'getModifiedEditor' in current ? current.getModifiedEditor() : current
            target.focus(); void target.getAction('actions.find')?.run()
        }
    }, [find])
    return <>{error && <StatusMessage error>{error}</StatusMessage>}<div ref={element} className="code-view" aria-label={`文件正文 ${path}`}/></>
}
