// True when no message has been seen for longer than silenceMs — the socket is
// presumed dead (e.g. a half-open connection that never fired 'close').
export function isConnectionStale(lastMessageAt: number, now: number, silenceMs: number): boolean {
  return now - lastMessageAt > silenceMs
}
