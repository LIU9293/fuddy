import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const protocolHandlers = vi.hoisted(() => new Map<string, (request: Request) => Response | Promise<Response>>())

vi.mock('electron', () => ({
  protocol: {
    handle: vi.fn((scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
      protocolHandlers.set(scheme, handler)
    })
  }
}))

import { createTestDatabase } from '../test-support/project-fixtures'
import { WorkspaceFilesService } from './workspace-files'
import { registerWorkspaceFileProtocol } from './workspace-file-protocol'

const temporaryDirectories: string[] = []

afterEach(() => {
  protocolHandlers.clear()
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
})

describe('workspace file preview protocol', () => {
  it('serves only validated project PDFs with an inline filename', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fuddy-file-protocol-'))
    temporaryDirectories.push(directory)
    const database = createTestDatabase(join(directory, 'test.sqlite'))
    const files = new WorkspaceFilesService(database, join(directory, 'files'))
    files.writeDataUrl('vows', 'reports/发布计划.pdf', 'data:application/pdf;base64,cGRm')
    registerWorkspaceFileProtocol(files)
    const handler = protocolHandlers.get('fuddy-file')!

    const response = await handler(new Request('fuddy-file://workspace/vows/reports/%E5%8F%91%E5%B8%83%E8%AE%A1%E5%88%92.pdf'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''%E5%8F%91%E5%B8%83%E8%AE%A1%E5%88%92.pdf")
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('pdf')

    const escaped = await handler(new Request('fuddy-file://workspace/vows/%2E%2E/outside.pdf'))
    expect(escaped.status).toBe(404)

    database.close()
  })
})
