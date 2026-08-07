import { describe, expect, it } from 'vitest'
import { normalizeChatMarkdown } from './markdown'

describe('normalizeChatMarkdown', () => {
  it('makes strong text followed by Chinese content CommonMark-compatible', () => {
    expect(normalizeChatMarkdown('**完成标准确认：**首批平台')).toBe('**完成标准确认：** 首批平台')
    expect(normalizeChatMarkdown('**Next:**Setup')).toBe('**Next:** Setup')
  })

  it('leaves already valid emphasis and code unchanged', () => {
    expect(normalizeChatMarkdown('保持 **未完成**。')).toBe('保持 **未完成**。')
    expect(normalizeChatMarkdown('`**标题：**正文`')).toBe('`**标题：**正文`')
    expect(normalizeChatMarkdown('```md\n**标题：**正文\n```')).toBe('```md\n**标题：**正文\n```')
  })
})
