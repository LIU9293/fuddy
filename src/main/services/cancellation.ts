export function cancellationError(cancellationSignal?: AbortSignal): Error | null {
  if (!cancellationSignal?.aborted) return null
  return cancellationSignal.reason instanceof Error
    ? cancellationSignal.reason
    : new Error('这次操作已停止。')
}

export function throwIfCancelled(cancellationSignal?: AbortSignal): void {
  const error = cancellationError(cancellationSignal)
  if (error) throw error
}

export function timeoutSignal(milliseconds: number, cancellationSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds)
  return cancellationSignal ? AbortSignal.any([cancellationSignal, timeout]) : timeout
}
