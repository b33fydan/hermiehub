import { describe, it, expect } from 'vitest'
import { isConnectionStale } from './heartbeat'

describe('isConnectionStale', () => {
  it('is false before the threshold', () => {
    expect(isConnectionStale(1000, 1000 + 39_000, 40_000)).toBe(false)
  })
  it('is false exactly at the threshold', () => {
    expect(isConnectionStale(1000, 1000 + 40_000, 40_000)).toBe(false)
  })
  it('is true past the threshold', () => {
    expect(isConnectionStale(1000, 1000 + 40_001, 40_000)).toBe(true)
  })
})
