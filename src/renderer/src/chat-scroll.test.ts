import { describe, expect, it } from 'vitest'
import { chatDistanceFromLatest, chatIsAtLatest, syncChatToLatest } from './chat-scroll'

describe('Mac chat scroll position', () => {
  it('shows the latest-message control only after leaving the bottom threshold', () => {
    expect(chatDistanceFromLatest({ scrollHeight: 1_000, scrollTop: 550, clientHeight: 400 })).toBe(50)
    expect(chatIsAtLatest({ scrollHeight: 1_000, scrollTop: 550, clientHeight: 400 })).toBe(true)
    expect(chatIsAtLatest({ scrollHeight: 1_000, scrollTop: 549, clientHeight: 400 })).toBe(false)
  })

  it('clamps overscroll at the latest message to zero', () => {
    expect(chatDistanceFromLatest({ scrollHeight: 600, scrollTop: 240, clientHeight: 400 })).toBe(0)
  })

  it('pins streaming content to the latest message only while following it', () => {
    const following = { scrollHeight: 1_000, scrollTop: 550, clientHeight: 400 }
    syncChatToLatest(following, true)
    expect(following.scrollTop).toBe(600)

    const readingEarlier = { scrollHeight: 1_000, scrollTop: 300, clientHeight: 400 }
    syncChatToLatest(readingEarlier, false)
    expect(readingEarlier.scrollTop).toBe(300)
  })
})
