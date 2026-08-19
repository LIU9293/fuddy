import { useEffect, useRef } from 'react'

export function ConfirmationDialog({
  title,
  description,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel
}: {
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    cancelRef.current?.focus()
    return () => dialog.close()
  }, [])

  return (
    <dialog
      className="confirmation-dialog"
      ref={dialogRef}
      aria-labelledby="confirmation-dialog-title"
      aria-describedby="confirmation-dialog-description"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onCancel()
      }}
    >
      <strong id="confirmation-dialog-title">{title}</strong>
      <p id="confirmation-dialog-description">{description}</p>
      <div>
        <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button
          className={destructive ? 'is-danger' : ''}
          type="button"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
