import type { CompanionEncryptedSyncEventInput } from '../../../src/shared/companion-sync'

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message)
  }
}

export const maximumEncryptedEventPayloadBytes = 1_900_000

export function assertEncryptedEventPayloadSizes(inputs: CompanionEncryptedSyncEventInput[]): void {
  for (const input of inputs) {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(input.payload)).byteLength
    if (payloadBytes > maximumEncryptedEventPayloadBytes) {
      throw new HttpError(
        413,
        `Encrypted event payload exceeds the ${maximumEncryptedEventPayloadBytes} byte Relay limit.`
      )
    }
  }
}

export async function enforceRateLimit(
  binding: RateLimit,
  request: Request,
  scope: string
): Promise<void> {
  const client = request.headers.get('CF-Connecting-IP')?.trim() || 'unknown-client'
  const outcome = await binding.limit({ key: `${scope}:${client}` })
  if (!outcome.success) throw new HttpError(429, '请求过于频繁，请稍后重试。')
}
