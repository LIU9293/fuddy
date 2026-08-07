const STRONG_BEFORE_WORD = /(\*\*[^*\n]+?\*\*)(?=[\p{L}\p{N}])/gu
const UNDERSCORE_STRONG_BEFORE_WORD = /(__[^_\n]+?__)(?=[\p{L}\p{N}])/gu

function normalizeTextSegment(value: string): string {
  return value
    .replace(STRONG_BEFORE_WORD, '$1 ')
    .replace(UNDERSCORE_STRONG_BEFORE_WORD, '$1 ')
}

/**
 * CommonMark does not treat a closing emphasis delimiter as valid when it is
 * immediately followed by a CJK/Latin letter in cases such as `**标题：**正文`.
 * Normalize only prose segments so code examples remain byte-for-byte intact.
 */
export function normalizeChatMarkdown(content: string): string {
  let fence: { marker: '`' | '~'; length: number } | null = null

  return content.split('\n').map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~'
      const length = fenceMatch[1].length
      if (!fence) fence = { marker, length }
      else if (fence.marker === marker && length >= fence.length) fence = null
      return line
    }
    if (fence) return line

    return line
      .split(/(`+[^`\n]*`+)/g)
      .map((segment, index) => index % 2 === 1 ? segment : normalizeTextSegment(segment))
      .join('')
  }).join('\n')
}
