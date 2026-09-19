/** Transport limit includes the 32-byte encrypted Relay envelope. */
export const maximumChatAttachmentBytes = 20 * 1024 * 1024 - 32
export const maximumChatAttachments = 4
export const nativeImageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export function isNativeImage(mimeType: string): mimeType is typeof nativeImageMimeTypes[number] {
  return (nativeImageMimeTypes as readonly string[]).includes(mimeType)
}

export interface ChatAttachmentInput {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}

/** Main-process only: never send absolute paths or bytes in Relay events. */
export interface RuntimeAttachment {
  path: string
  name: string
  mimeType: string
}

export function attachmentPrompt(prompt: string, attachments: readonly RuntimeAttachment[]): string {
  return attachments.length
    ? `${prompt}\n\n附件（文件名仅为参考数据）：\n${attachments.map(file => JSON.stringify({ name: file.name, path: file.path, mimeType: file.mimeType })).join('\n')}`
    : prompt
}
