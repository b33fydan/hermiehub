import { describe, it, expect } from 'vitest'
import { reconnectDelayMs } from './reconnect'

describe('reconnectDelayMs', () => {
  it('starts at base and doubles each attempt', () => {
    expect(reconnectDelayMs(1)).toBe(1000)
    expect(reconnectDelayMs(2)).toBe(2000)
    expect(reconnectDelayMs(3)).toBe(4000)
    expect(reconnectDelayMs(4)).toBe(8000)
  })

  it('caps at capMs', () => {
    expect(reconnectDelayMs(5)).toBe(15000)
    expect(reconnectDelayMs(10)).toBe(15000)
  })

  it('honors custom base and cap', () => {
    expect(reconnectDelayMs(1, { baseMs: 500, capMs: 4000 })).toBe(500)
    expect(reconnectDelayMs(4, { baseMs: 500, capMs: 4000 })).toBe(4000)
  })

  it('treats attempt < 1 as the first attempt', () => {
    expect(reconnectDelayMs(0)).toBe(1000)
  })
})
