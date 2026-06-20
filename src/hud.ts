export interface RelayHudInput {
  type?: string
  text?: string
  hud?: string
  message?: string
  error?: string
  ok?: boolean
  source?: string
}

// The HUD text a relay message should display, or null to leave the HUD unchanged.
// Keepalive pong/ping return null so the heartbeat never overwrites the last reply.
export function hudFromRelay(msg: RelayHudInput): string | null {
  if (msg.type === 'pong' || msg.type === 'ping') return null
  if (msg.type === 'transcript' && msg.text) return `YOU SAID\n${msg.text}`
  if (msg.hud) return msg.hud
  if (msg.type === 'agent_started') return 'AGENT COOKING\n' + (msg.message || 'Agent started.')
  if (msg.type === 'agent_result') {
    const label = msg.source === 'hermes' ? 'BERNIE' : String(msg.source || 'AGENT').toUpperCase()
    return `${msg.ok ? `${label} SAYS` : `${label} ERROR`}\n${msg.text || msg.error || 'No response.'}`
  }
  if (msg.message) return `HERMIEHUB\n${msg.message}`
  return null
}
