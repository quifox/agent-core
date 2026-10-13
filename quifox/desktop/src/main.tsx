import { createRoot } from 'react-dom/client'
import { DesktopEngine } from './engine.js'
import { App } from './app.js'
import './tokens.css'
import './styles.css'
import './workspace.css'

createRoot(document.getElementById('root')!).render(<App engine={new DesktopEngine()}/> )
