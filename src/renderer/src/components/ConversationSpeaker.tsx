import type { ConversationAuthorRecord, ConversationAuthors } from '../conversation-authors'

export function ConversationUserSpeaker({ message, authors }: {
  message: ConversationAuthorRecord
  authors: ConversationAuthors
}): React.JSX.Element | null {
  return authors.showSpeakers ? <ConversationSpeaker {...authors.speaker(message)} person /> : null
}

export function ConversationSpeaker({ label, person, isSelf = false }: {
  label: string
  person?: boolean
  isSelf?: boolean
}): React.JSX.Element {
  const initial = Array.from(label.trim())[0] ?? '?'
  return <div className="chat-speaker" aria-label={isSelf ? `${label}（你）` : label}>
    {person && <span className="chat-speaker-avatar" aria-hidden="true">{initial}</span>}
    <strong>{label}{isSelf ? ' · 你' : ''}</strong>
  </div>
}
