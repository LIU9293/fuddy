import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationShell } from './ConversationShell'

describe('ConversationShell', () => {
  it('renders one shared timeline and composer structure for every chat surface', () => {
    const markup = renderToStaticMarkup(createElement(ConversationShell, {
      ariaLabel: '测试对话',
      className: 'business-specific-chat',
      composerTopContent: createElement('div', { className: 'queue' }, 'queued'),
      composer: createElement('form', { className: 'composer' }, 'composer'),
      children: createElement('article', null, 'message')
    }))

    expect(markup).toContain('conversation-shell business-specific-chat')
    expect(markup).toContain('class="conversation-thread"')
    expect(markup).toContain('class="conversation-thread-inner"')
    expect(markup).toContain('class="conversation-composer-dock"')
    expect(markup.indexOf('queued')).toBeLessThan(markup.indexOf('composer</form>'))
  })
})
