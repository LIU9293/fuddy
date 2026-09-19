import { describe, expect, it } from 'vitest'
import { chatAttachmentSchema, sendAgentRunMessageSchema } from './schemas'

describe('Chat attachment IPC validation', () => {
  const file = { id: 'file', name: 'report.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERg==' }
  it('accepts documents and preserves their declared type', () => {
    expect(chatAttachmentSchema.parse(file)).toEqual(file)
    expect(sendAgentRunMessageSchema.parse({ requestId: 'message', runId: 'run', prompt: 'read', attachments: [file] }).attachments).toEqual([file])
  })
  it.each(['data:text/plain;base64,JVBERg==', 'data:application/pdf;base64,!', 'data:application/pdf;base64,'])('rejects corrupt or mismatched data: %s', dataUrl => {
    expect(chatAttachmentSchema.safeParse({ ...file, dataUrl }).success).toBe(false)
  })
  it('enforces count and decoded size, including encryption overhead', () => {
    expect(sendAgentRunMessageSchema.safeParse({ requestId: 'message', runId: 'run', prompt: 'read', attachments: Array(5).fill(file) }).success).toBe(false)
    expect(chatAttachmentSchema.safeParse({ ...file, dataUrl: `data:application/pdf;base64,${Buffer.alloc(20 * 1024 * 1024).toString('base64')}` }).success).toBe(false)
  })
})
