import { chatTitleModel, chatTitleMessages, parseChatTitleModelResult } from '../../../src/shared/agent-run-title'

export async function generateChatTitle(ai: Pick<Ai, 'run'>, prompt: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      ai.run(chatTitleModel, {
        messages: chatTitleMessages(prompt),
        max_tokens: 64,
        temperature: 0.1
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('title_timeout')), 10_000)
      })
    ])
    return parseChatTitleModelResult(result)
  } finally {
    clearTimeout(timer)
  }
}
