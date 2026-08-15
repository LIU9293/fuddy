import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'

export const defaultSidebarWidth = 258
export const minimumSidebarWidth = 220
export const maximumSidebarWidth = 420
const sidebarWidthStorageKey = 'project-agent.sidebar-width'

export function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(maximumSidebarWidth, Math.max(minimumSidebarWidth, value)))
}

function initialSidebarWidth(): number {
  const stored = Number.parseFloat(window.localStorage.getItem(sidebarWidthStorageKey) ?? '')
  return Number.isFinite(stored) ? clampSidebarWidth(stored) : defaultSidebarWidth
}

export interface SidebarLayoutController {
  open: boolean
  width: number
  resizing: boolean
  shellStyle: CSSProperties
  collapse: () => void
  expand: () => void
  resetWidth: () => void
  resizeByKeyboard: (key: string) => void
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  moveResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  finishResize: (event: ReactPointerEvent<HTMLDivElement>) => void
  cancelResize: () => void
}

export function useSidebarLayout(): SidebarLayoutController {
  const [open, setOpen] = useState(true)
  const [width, setWidth] = useState(initialSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    window.localStorage.setItem(sidebarWidthStorageKey, String(width))
  }, [width])

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
    setResizing(true)
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = resize.current
    if (!current || current.pointerId !== event.pointerId) return
    setWidth(clampSidebarWidth(current.startWidth + event.clientX - current.startX))
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
  }

  function cancelResize(): void {
    resize.current = null
    setResizing(false)
  }

  function resizeByKeyboard(key: string): void {
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home') return
    setWidth((current) => key === 'Home'
      ? defaultSidebarWidth
      : clampSidebarWidth(current + (key === 'ArrowRight' ? 12 : -12)))
  }

  return {
    open,
    width,
    resizing,
    shellStyle: { '--sidebar-width': `${width}px` } as CSSProperties,
    collapse: () => setOpen(false),
    expand: () => setOpen(true),
    resetWidth: () => setWidth(defaultSidebarWidth),
    resizeByKeyboard,
    startResize,
    moveResize,
    finishResize,
    cancelResize
  }
}
