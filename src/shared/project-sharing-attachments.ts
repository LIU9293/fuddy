import { z } from 'zod'

export const sharedAttachmentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  size: z.number().int().positive().max(20 * 1024 * 1024 - 32),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: z.string(),
  kind: z.enum(['input', 'artifact']),
  runId: z.string(),
  messageId: z.string().nullable(),
  artifactId: z.string().nullable(),
  inputId: z.string().nullable().optional()
}).strict()

export type SharedAttachmentView = z.infer<typeof sharedAttachmentSchema>

export function sharedAttachmentAssociatedData(
  projectId: string, attachmentId: string, keyEpoch: number
): string {
  return `fuddy:shared-project-attachment:v1:${projectId}:${keyEpoch}:${attachmentId}`
}
