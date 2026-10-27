import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { conversationAuthors, type ConversationAuthorRecord } from './conversation-authors'
import { ConversationUserSpeaker } from './components/ConversationSpeaker'
import { UserMessageBubble } from './components/UserMessageBubble'

const currentUser = { id: 'user-kai', displayName: 'Kai' }
const self: ConversationAuthorRecord = {
  role: 'user', authorUserId: currentUser.id, authorSnapshot: { displayName: 'Kai', avatarRef: null }
}
const other: ConversationAuthorRecord = {
  role: 'user', authorUserId: 'user-lin', authorSnapshot: { displayName: '小林', avatarRef: null }
}
const legacy: ConversationAuthorRecord = { role: 'user', authorUserId: null, authorSnapshot: null }

describe('conversation authors', () => {
  it('hides personal message headers for legacy and signed-in messages in a single-person chat', () => {
    const authors = conversationAuthors([legacy, self, { role: 'assistant' }], currentUser)
    expect(authors.showSpeakers).toBe(false)
    for (const message of [legacy, self]) {
      expect(renderToStaticMarkup(createElement(ConversationUserSpeaker, { message, authors }))).toBe('')
    }
    expect(conversationAuthors([legacy], currentUser).showSpeakers).toBe(false)
  })

  it('shows the actual author of each message when multiple people participate', () => {
    const authors = conversationAuthors([self, other], currentUser)
    expect(authors.showSpeakers).toBe(true)
    const ownMarkup = renderToStaticMarkup(createElement(ConversationUserSpeaker, { message: self, authors }))
    const otherMarkup = renderToStaticMarkup(createElement(ConversationUserSpeaker, { message: other, authors }))
    expect(ownMarkup).toContain('Kai · 你')
    expect(ownMarkup).toContain('aria-label="Kai（你）"')
    expect(otherMarkup).toContain('<strong>小林</strong>')
    expect(otherMarkup).not.toContain(' · 你')
  })

  it('recovers missing snapshots by user ID without overwriting the name recorded at send time', () => {
    const earlierSelf = { ...self, authorSnapshot: null }
    const earlierOther = { ...other, authorSnapshot: null }
    const authors = conversationAuthors([earlierSelf, earlierOther, self, other], currentUser)
    expect(authors.speaker(earlierSelf)).toEqual({ label: 'Kai', isSelf: true })
    expect(authors.speaker(earlierOther)).toEqual({ label: '小林', isSelf: false })
    expect(authors.speaker({ ...self, authorSnapshot: { displayName: '旧名字', avatarRef: null } }))
      .toEqual({ label: '旧名字', isSelf: true })
  })

  it('uses the account and creator names only when their IDs match the message author', () => {
    const messages = [{ ...self, authorSnapshot: null }, { ...other, authorSnapshot: null }]
    const authors = conversationAuthors(messages, currentUser, { userId: other.authorUserId, snapshot: other.authorSnapshot })
    expect(authors.speaker(messages[0])).toEqual({ label: 'Kai', isSelf: true })
    expect(authors.speaker(messages[1])).toEqual({ label: '小林', isSelf: false })
    expect(authors.speaker(legacy)).toEqual({ label: '未记录发送者', isSelf: false })
    expect(authors.speaker({ role: 'user', authorUserId: 'third-user' }))
      .toEqual({ label: '用户 third-', isSelf: false })
  })

  it('distinguishes different accounts with the same name and ignores assistant identities', () => {
    expect(conversationAuthors([self, { ...other, authorSnapshot: self.authorSnapshot }], currentUser).showSpeakers).toBe(true)
    expect(conversationAuthors([self, { ...other, role: 'assistant' }], currentUser).showSpeakers).toBe(false)
    expect(conversationAuthors([self, { ...self, authorSnapshot: { displayName: '新名字', avatarRef: null } }], currentUser).showSpeakers).toBe(false)
  })

  it('does not count the signed-in viewer or chat creator as an extra sender', () => {
    expect(conversationAuthors([other], currentUser, { userId: currentUser.id, snapshot: self.authorSnapshot }).showSpeakers).toBe(false)
    const authors = conversationAuthors([{ ...self, authorSnapshot: null }, other], { id: currentUser.id })
    expect(authors.speaker({ ...self, authorSnapshot: null })).toEqual({ label: '用户 user-k', isSelf: true })
  })
})

describe('user message bubbles', () => {
  it('preserves multiline input, blank lines and numbering without extra Markdown blocks', () => {
    const content = '总结一下现在的进度：\n\n1. route scanner 是不是已经在跑？\n2. 询价我们是怎么做的？\n\n3. 交易服务测试过么？'
    const markup = renderToStaticMarkup(createElement(UserMessageBubble, { content }))
    expect(markup).toBe(`<div class="chat-bubble">${content}</div>`)
    expect(markup).not.toContain('<ol>')
    expect(markup).not.toContain('<p>')
  })

  it('keeps typed Markdown literal and escapes HTML in user input', () => {
    const markup = renderToStaticMarkup(createElement(UserMessageBubble, { content: '**标题**\n<script>alert(1)</script>' }))
    expect(markup).toContain('**标题**\n&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
  })
})
