import { Info, X } from 'lucide-react'

export function NoticeToast({
  notice,
  onClose,
  className = 'notice-toast'
}: {
  notice: string
  onClose: () => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={className} role="status" aria-live="polite">
      <Info size={15} aria-hidden="true" />
      <span>{notice}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={14} /></button>
    </div>
  )
}
