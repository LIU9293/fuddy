import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { WebResearchService } from './web-research'

describe('WebResearchService', () => {
  it('returns HTTPS search sources with their URLs', async () => {
    const fetchImpl = vi.fn(async () => new Response(`
      <a class="result__a" href="https://example.com/article">Example result</a>
      <div class="result__snippet">A useful public source.</div>
    `, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch
    const result = await new WebResearchService(fetchImpl).search('example')
    expect(result.sources[0]).toMatchObject({ title: 'Example result', url: 'https://example.com/article' })
  })

  it('allows local and private-network HTTP pages', async () => {
    const fetchImpl = vi.fn(async () => new Response('<title>Local service</title><p>ready</p>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })) as unknown as typeof fetch
    const service = new WebResearchService(fetchImpl)
    await expect(service.read('http://127.0.0.1:8787/status')).resolves.toMatchObject({
      sources: [{ title: 'Local service', url: 'http://127.0.0.1:8787/status' }]
    })
    await expect(service.read('http://192.168.1.20/health')).resolves.toBeTruthy()
  })

  it('still refuses unsupported URL protocols', async () => {
    const service = new WebResearchService(vi.fn() as unknown as typeof fetch)
    await expect(service.read('file:///tmp/secret')).rejects.toThrow('HTTP')
  })

  it('actually reads a service bound to localhost over HTTP', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>Local Project Service</title><main>healthy</main>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Local test server did not bind.')
      const result = await new WebResearchService().read(`http://127.0.0.1:${address.port}/health`)
      expect(result.sources[0]).toMatchObject({ title: 'Local Project Service', excerpt: 'Local Project Service healthy' })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
