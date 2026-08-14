export const chatLatestDistanceThreshold = 50

export interface ChatScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function chatDistanceFromLatest(metrics: ChatScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

export function chatIsAtLatest(metrics: ChatScrollMetrics): boolean {
  return chatDistanceFromLatest(metrics) <= chatLatestDistanceThreshold
}

export function syncChatToLatest(metrics: ChatScrollMetrics, followingLatest: boolean): void {
  if (!followingLatest) return
  metrics.scrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
}
