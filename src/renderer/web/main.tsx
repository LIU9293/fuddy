import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createPreviewApi } from './preview-api'
import WebPreview from './WebPreview'
import '../src/styles.css'
import './preview.css'

// This entry is never imported by Electron. Do not initialize Electron Sentry here.
const empty = new URLSearchParams(location.search).get('fixture') === 'empty'
window.projectAgent = createPreviewApi(empty)

// Keep components separate so Fast Refresh never re-creates this root.
createRoot(document.getElementById('root')!).render(<StrictMode><WebPreview empty={empty} /></StrictMode>)
