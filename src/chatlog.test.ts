import { describe, it, expect } from 'vitest'
import { chatEntryFromRelay, agentLabel } from './chatlog'

describe('agentLabel', () => {
  it('maps known sources to friendly names', () => {
    expect(agentLabel('hermes')).toBe('Bernie')
    expect(agentLabel('codex')).toBe('Codex')
    expect(agentLabel('demo')).toBe('Demo')
  })
  it('uppercases unknown sources and defaults to Agent', () => {
    expect(agentLabel('foo')).toBe('FOO')
    expect(agentLabel(undefined)).toBe('Agent')
  })
})

describe('chatEntryFromRelay', () => {
  it('maps a transcript to a user entry', () => {
    expect(chatEntryFromRelay({ type: 'transcript', text: 'hello there' }))
      .toEqual({ role: 'user', text: 'hello there' })
  })
  it('maps a successful agent_result to a labeled agent entry', () => {
    expect(chatEntryFromRelay({ type: 'agent_result', ok: true, source: 'hermes', text: 'hi Dan' }))
      .toEqual({ role: 'agent', label: 'Bernie', text: 'hi Dan' })
  })
  it('returns null for a failed agent_result', () => {
    expect(chatEntryFromRelay({ type: 'agent_result', ok: false, source: 'hermes', text: 'boom' }))
      .toBeNull()
  })
  it('returns null for empty text', () => {
    expect(chatEntryFromRelay({ type: 'transcript', text: '   ' })).toBeNull()
    expect(chatEntryFromRelay({ type: 'agent_result', ok: true, text: '' })).toBeNull()
  })
  it('returns null for status/unknown messages', () => {
    expect(chatEntryFromRelay({ type: 'agent_started', message: 'cooking' } as { type: string })).toBeNull()
    expect(chatEntryFromRelay({ type: 'pong' })).toBeNull()
  })
})
