export interface WebResearchSource {
  title: string
  url: string
  excerpt: string
}

export interface WebResearchResult {
  query: string
  sources: WebResearchSource[]
}

type FetchLike = typeof fetch

function decodeHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeWebUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export class WebResearchService {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(query: string): Promise<WebResearchResult> {
    const normalized = query.trim()
    if (!normalized) throw new Error('联网搜索需要查询内容。')
    const response = await this.fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`, {
      headers: { 'User-Agent': 'ProjectAgent/1.0' },
      signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) throw new Error(`联网搜索失败（HTTP ${response.status}）。`)
    const html = await response.text()
    const sources: WebResearchSource[] = []
    const resultPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>)?/gi
    for (const match of html.matchAll(resultPattern)) {
      const rawUrl = match[1].replaceAll('&amp;', '&')
      let url = rawUrl
      try {
        const redirect = new URL(rawUrl, 'https://duckduckgo.com')
        url = redirect.searchParams.get('uddg') ?? redirect.toString()
      } catch {
        // Validation below drops malformed results.
      }
      const safeUrl = safeWebUrl(url)
      if (!safeUrl) continue
      sources.push({
        title: decodeHtml(match[2]).slice(0, 240),
        url: safeUrl,
        excerpt: decodeHtml(match[3] ?? '').slice(0, 700)
      })
      if (sources.length >= 6) break
    }
    return { query: normalized, sources }
  }

  async read(url: string): Promise<WebResearchResult> {
    const safeUrl = safeWebUrl(url)
    if (!safeUrl) throw new Error('工作助理只读取 HTTP 或 HTTPS 页面。')
    const response = await this.fetchImpl(safeUrl, {
      headers: { 'User-Agent': 'ProjectAgent/1.0' },
      signal: AbortSignal.timeout(12_000),
      redirect: 'follow'
    })
    if (!response.ok) throw new Error(`网页读取失败（HTTP ${response.status}）。`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!safeWebUrl(response.url || safeUrl)) throw new Error('网页跳转到了不支持的协议。')
    if (!contentType.includes('text/') && !contentType.includes('application/json')) {
      throw new Error('这个 URL 不是可读取的文本页面。')
    }
    const body = (await response.text()).slice(0, 1_000_000)
    const title = decodeHtml(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? new URL(safeUrl).hostname)
    return {
      query: safeUrl,
      sources: [{ title, url: safeUrl, excerpt: decodeHtml(body).slice(0, 8_000) }]
    }
  }
}
