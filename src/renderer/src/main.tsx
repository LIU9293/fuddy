import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/electron/renderer'
import App from './App'
import { SENTRY_DSN, SENTRY_PROJECT } from '../../shared/sentry'
import './styles.css'

Sentry.init({
  dsn: SENTRY_DSN,
  environment: import.meta.env.DEV ? 'development' : 'production',
  release: `${SENTRY_PROJECT}@${import.meta.env.VITE_APP_VERSION ?? '0.1.0'}`,
  sendDefaultPii: false
})

function captureReactError(error: unknown, componentStack: string | null | undefined, boundary: string): void {
  Sentry.captureException(error, {
    tags: { boundary },
    contexts: { react: { componentStack: componentStack ?? '' } }
  })
}

createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, errorInfo) => captureReactError(error, errorInfo.componentStack, 'react.uncaught'),
  onCaughtError: (error, errorInfo) => captureReactError(error, errorInfo.componentStack, 'react.caught'),
  onRecoverableError: (error, errorInfo) => captureReactError(error, errorInfo.componentStack, 'react.recoverable')
}).render(
  <StrictMode>
    <App />
  </StrictMode>
)
