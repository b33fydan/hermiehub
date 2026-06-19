export type ChatRole = 'user' | 'agent'

export interface ChatEntry {
  role: ChatRole
  label?: string
  text: string
}

export interface RelayLike {
  type?: string
  text?: string
  ok?: boolean
  source?: string
}

// Friendly display name for an agent source.
export function agentLabel(source?: string): string {
  if (source === 'hermes') return 'Bernie'
  if (source === 'codex') return 'Codex'
  if (source === 'demo') return 'Demo'
  return source ? source.toUpperCase() : 'Agent'
}

// Map a relay message to a chat entry, or null if it should not appear in the
// conversation thread (status, errors, unknown types, empty text).
export function chatEntryFromRelay(msg: RelayLike): ChatEntry | null {
  const text = (msg.text ?? '').trim()
  if (msg.type === 'transcript') {
    return text ? { role: 'user', text } : null
  }
  if (msg.type === 'agent_result' && msg.ok === true) {
    return text ? { role: 'agent', label: agentLabel(msg.source), text } : null
  }
  return null
}
