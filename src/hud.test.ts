import { describe, it, expect } from 'vitest'
import { hudFromRelay } from './hud'

describe('hudFromRelay', () => {
  it('ignores a keepalive pong (the bug: must NOT clobber the HUD)', () => {
    expect(hudFromRelay({ type: 'pong', message: 'pong' })).toBeNull()
  })

  it('ignores a ping', () => {
    expect(hudFromRelay({ type: 'ping' })).toBeNull()
  })

  it('shows a transcript as YOU SAID', () => {
    expect(hudFromRelay({ type: 'transcript', text: 'hi there' })).toBe('YOU SAID\nhi there')
  })

  it('labels a hermes reply BERNIE SAYS', () => {
    expect(hudFromRelay({ type: 'agent_result', ok: true, source: 'hermes', text: 'yo' })).toBe('BERNIE SAYS\nyo')
  })

  it('labels a codex reply CODEX SAYS', () => {
    expect(hudFromRelay({ type: 'agent_result', ok: true, source: 'codex', text: 'yo' })).toBe('CODEX SAYS\nyo')
  })

  it('shows a failed reply as ERROR', () => {
    expect(hudFromRelay({ type: 'agent_result', ok: false, source: 'hermes', error: 'boom' })).toBe('BERNIE ERROR\nboom')
  })

  it('uses an explicit hud field when present', () => {
    expect(hudFromRelay({ type: 'hello', hud: 'HI\nthere', message: 'ignored' })).toBe('HI\nthere')
  })

  it('shows agent_started as AGENT COOKING', () => {
    expect(hudFromRelay({ type: 'agent_started', message: 'cooking' })).toBe('AGENT COOKING\ncooking')
  })

  it('falls back to a plain message', () => {
    expect(hudFromRelay({ type: 'whatever', message: 'note' })).toBe('HERMIEHUB\nnote')
  })

  it('returns null when there is nothing to show', () => {
    expect(hudFromRelay({ type: 'mystery' })).toBeNull()
  })
})
