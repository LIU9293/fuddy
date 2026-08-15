import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesDirectory = dirname(fileURLToPath(import.meta.url))
const rendererDirectory = dirname(stylesDirectory)

describe('renderer CSS architecture', () => {
  it('keeps the cascade entrypoint explicit and ordered', () => {
    const entrypoint = readFileSync(join(rendererDirectory, 'styles.css'), 'utf8')
    const imports = [...entrypoint.matchAll(/@import '([^']+)'/g)].map((match) => match[1])

    expect(imports).toEqual([
      './styles/tokens.css',
      './styles/base.css',
      './styles/page-layout.css',
      './styles/shell-settings-inbox.css',
      './styles/conversations-workspace.css',
      './styles/agent-runs.css',
      './styles/conversation-typography.css',
      './styles/settings-current.css'
    ])
    expect(entrypoint).not.toContain('final-overrides')
  })

  it('keeps root-level design tokens in one file', () => {
    const featureFiles = [
      'base.css',
      'page-layout.css',
      'shell-settings-inbox.css',
      'conversations-workspace.css',
      'agent-runs.css',
      'conversation-typography.css',
      'settings-current.css'
    ]

    for (const file of featureFiles) {
      expect(readFileSync(join(stylesDirectory, file), 'utf8'), file).not.toMatch(/(^|\n)\s*:root\s*\{/)
    }
  })
})
