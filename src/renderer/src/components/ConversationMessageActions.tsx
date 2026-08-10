import { Copy } from 'lucide-react'
import { useState } from 'react'

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export function ConversationMessageActions({
  content,
  createdAt
}: {
  content: string
  createdAt: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copyMessage = async (): Promise<void> => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <div className="chat-turn-hover-actions">
      <time dateTime={createdAt}>{formatTimestamp(createdAt)}</time>
      <button type="button" aria-label="复制消息" title={copied ? '已复制' : '复制'} onClick={() => void copyMessage()}>
        <Copy size={13} />
      </button>
    </div>
  )
}
