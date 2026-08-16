import { ArrowDown } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { chatIsAtLatest, syncChatToLatest } from '../chat-scroll'

interface ConversationShellProps {
  ariaLabel: string
  children: ReactNode
  composer: ReactNode
  composerTopContent?: ReactNode
  className?: string
  resetKey?: string | null
}

export function ConversationShell({
  ariaLabel,
  children,
  composer,
  composerTopContent,
  className = '',
  resetKey = null
}: ConversationShellProps): React.JSX.Element {
  const threadRef = useRef<HTMLElement | null>(null)
  const isAtLatestMessageRef = useRef(true)
  const previousResetKeyRef = useRef(resetKey)
  const [isAtLatestMessage, setIsAtLatestMessage] = useState(true)

  useLayoutEffect(() => {
    const reset = previousResetKeyRef.current !== resetKey
    if (reset) {
      previousResetKeyRef.current = resetKey
      isAtLatestMessageRef.current = true
      setIsAtLatestMessage(true)
    }
    const thread = threadRef.current
    if (thread) syncChatToLatest(thread, isAtLatestMessageRef.current)
  })

  function updateLatestMessagePosition(): void {
    const thread = threadRef.current
    if (!thread) return
    const atLatest = chatIsAtLatest(thread)
    isAtLatestMessageRef.current = atLatest
    setIsAtLatestMessage(atLatest)
  }

  function scrollToLatestMessage(): void {
    isAtLatestMessageRef.current = true
    setIsAtLatestMessage(true)
    const thread = threadRef.current
    thread?.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className={`conversation-shell ${className}`.trim()}>
      <section
        className="conversation-thread"
        aria-label={ariaLabel}
        ref={threadRef}
        onScroll={updateLatestMessagePosition}
      >
        <div className="conversation-thread-inner">{children}</div>
      </section>
      <footer className="conversation-composer-dock">
        {!isAtLatestMessage && (
          <button
            type="button"
            className="chat-scroll-to-latest"
            onClick={scrollToLatestMessage}
            aria-label="回到最新消息"
            title="回到最新消息"
          >
            <ArrowDown size={17} strokeWidth={2.2} />
          </button>
        )}
        {composerTopContent}
        {composer}
      </footer>
    </div>
  )
}
