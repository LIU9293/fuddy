import { describe, expect, it } from 'vitest'
import { chatDistanceFromLatest, chatIsAtLatest } from './chat-scroll'

describe('Mac chat scroll position', () => {
  it('shows the latest-message control only after leaving the bottom threshold', () => {
    expect(chatDistanceFromLatest({ scrollHeight: 1_000, scrollTop: 556, clientHeight: 400 })).toBe(44)
    expect(chatIsAtLatest({ scrollHeight: 1_000, scrollTop: 556, clientHeight: 400 })).toBe(true)
    expect(chatIsAtLatest({ scrollHeight: 1_000, scrollTop: 555, clientHeight: 400 })).toBe(false)
  })

  it('clamps overscroll at the latest message to zero', () => {
    expect(chatDistanceFromLatest({ scrollHeight: 600, scrollTop: 240, clientHeight: 400 })).toBe(0)
  })
})
