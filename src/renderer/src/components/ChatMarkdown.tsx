import { Check, Copy } from 'lucide-react'
import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMarkdownBlocks } from '../../../../vendor/t3-code/markdown-stream-blocks'
import { normalizeChatMarkdown } from '../markdown'

function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/iu.test(href)
}

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const source = useRef<HTMLPreElement>(null)
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copied, setCopied] = useState(false)
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/(?:^|\s)language-([^\s]+)/u)?.[1] : null

  useEffect(() => () => { if (reset.current) clearTimeout(reset.current) }, [])

  async function copy(): Promise<void> {
    const text = source.current?.textContent
    if (!text) return
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/u, ''))
      setCopied(true)
      if (reset.current) clearTimeout(reset.current)
      reset.current = setTimeout(() => setCopied(false), 2_000)
    } catch {
      source.current?.focus()
    }
  }

  return (
    <div className="chat-code-block">
      <div className="chat-code-header">
        {language && <span>{language}</span>}
        <button type="button" onClick={() => void copy()} aria-label={copied ? '已复制代码' : '复制代码'}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre ref={source} tabIndex={0}>{children}</pre>
    </div>
  )
}

const MarkdownBlock = memo(function MarkdownBlock({ content, onOpenLink }: {
  content: string
  onOpenLink?: (href: string) => boolean
}): React.JSX.Element {
  return <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => onOpenLink || isExternalLink(url) || url.startsWith('#') ? defaultUrlTransform(url) : ''}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          img: ({ src, alt }) => {
            if (!src) return <span>{alt}</span>
            if (/^https?:/iu.test(src)) return <img src={src} alt={alt} loading="lazy" />
            return onOpenLink
              ? <button className="message-attachment" type="button" onClick={() => onOpenLink(src)}>{alt || '查看图片'}</button>
              : <span>{alt}</span>
          },
          a: ({ children, href, node: _node, ...props }) => {
            const external = href && isExternalLink(href)
            return (
              <a {...props} href={href || undefined}
                target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}
                onClick={(event) => {
                  if (!href || href.startsWith('#')) return
                  if (onOpenLink?.(href) || !external) event.preventDefault()
                }}>
                {children}
              </a>
            )
          }
        }}
      >{content}</ReactMarkdown>
})

export const ChatMarkdown = memo(function ChatMarkdown({
  content,
  streaming = false,
  onOpenLink,
  className = ''
}: {
  content: string
  streaming?: boolean
  onOpenLink?: (href: string) => boolean
  className?: string
}): React.JSX.Element {
  const markdown = normalizeChatMarkdown(content)
  const blocks = (streaming ? splitMarkdownBlocks(markdown) : null) ?? [markdown]
  return (
    <div className={['chat-markdown', streaming ? 'is-streaming' : '', className].filter(Boolean).join(' ')}>
      {blocks.map((block, index) => <MarkdownBlock key={index} content={block} onOpenLink={onOpenLink} />)}
      {streaming && <span className="streaming-caret" aria-hidden="true" />}
    </div>
  )
})
