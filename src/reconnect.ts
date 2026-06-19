export interface BackoffOptions {
  baseMs?: number
  capMs?: number
}

// Exponential backoff delay (ms) for reconnect attempt N (1-based), capped.
// e.g. 1000, 2000, 4000, 8000, then capped at 15000.
export function reconnectDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 1000
  const cap = opts.capMs ?? 15000
  const n = Math.max(1, Math.floor(attempt))
  return Math.min(base * 2 ** (n - 1), cap)
}
