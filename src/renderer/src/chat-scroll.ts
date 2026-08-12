export const chatLatestDistanceThreshold = 44

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
