import type {
  WorkAssistantImageAttachment,
  WorkAssistantImageMimeType
} from '../../shared/contracts'

export const maxChatImages = 4
export const maxChatImageBytes = 5 * 1024 * 1024

const chatImageMimeTypes: readonly WorkAssistantImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

function isChatImageMimeType(value: string): value is WorkAssistantImageMimeType {
  return chatImageMimeTypes.includes(value as WorkAssistantImageMimeType)
}

function readImageAttachment(file: File): Promise<WorkAssistantImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`))
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !isChatImageMimeType(file.type)) {
        reject(new Error(`不支持图片 ${file.name}`))
        return
      }
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        mimeType: file.type,
        dataUrl: reader.result
      })
    }
    reader.readAsDataURL(file)
  })
}

export async function prepareChatImages(
  files: File[],
  currentCount: number
): Promise<{ attachments: WorkAssistantImageAttachment[]; error: string | null }> {
  const availableSlots = maxChatImages - currentCount
  if (availableSlots <= 0) {
    return { attachments: [], error: `每条消息最多添加 ${maxChatImages} 张图片。` }
  }

  const supported = files.filter((file) => isChatImageMimeType(file.type) && file.size <= maxChatImageBytes)
  const selected = supported.slice(0, availableSlots)
  const problems: string[] = []
  if (files.some((file) => !isChatImageMimeType(file.type))) {
    problems.push('仅支持 PNG、JPEG、WEBP 和 GIF')
  }
  if (files.some((file) => file.size > maxChatImageBytes)) {
    problems.push('单张图片不能超过 5MB')
  }
  if (supported.length > availableSlots) {
    problems.push(`每条消息最多添加 ${maxChatImages} 张图片`)
  }

  try {
    return {
      attachments: await Promise.all(selected.map(readImageAttachment)),
      error: problems.length > 0 ? `${problems.join('；')}。` : null
    }
  } catch (error) {
    return {
      attachments: [],
      error: error instanceof Error ? error.message : '图片读取失败。'
    }
  }
}
