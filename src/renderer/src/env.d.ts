import type { DesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    projectAgent: DesktopApi
  }
}

export {}
