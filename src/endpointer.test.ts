import { describe, it, expect } from 'vitest'
import { rms16, createEndpointer } from './endpointer'

const RATE = 16_000

// Build a PCM chunk (s16le mono) of `ms` duration whose RMS ≈ `amplitude` (0..1).
// Alternating +/- full-scale*amplitude gives every sample magnitude = amplitude,
// so RMS ≈ amplitude.
function chunkMs(ms: number, amplitude: number): Uint8Array {
  const samples = Math.round((ms / 1000) * RATE)
  const buf = new Uint8Array(samples * 2)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < samples; i++) {
    const v = (i % 2 === 0 ? 1 : -1) * amplitude * 32767
    view.setInt16(i * 2, v, true)
  }
  return buf
}

describe('rms16', () => {
  it('returns 0 for silence', () => {
    expect(rms16(chunkMs(100, 0))).toBeCloseTo(0, 5)
  })

  it('returns ~amplitude for a steady signal', () => {
    expect(rms16(chunkMs(100, 0.3))).toBeCloseTo(0.3, 2)
  })

  it('returns 0 for an empty chunk', () => {
    expect(rms16(new Uint8Array(0))).toBe(0)
  })
})

export { chunkMs }

const baseOpts = {
  sampleRate: RATE,
  silenceRmsThreshold: 0.05,
  silenceHangoverMs: 1500,
  minSpeechMs: 300,
  maxUtteranceMs: 15_000,
  leadGraceMs: 4000,
}
const LOUD = 0.3
const QUIET = 0.0

describe('createEndpointer', () => {
  it('stops with reason "silence" ~1.5s after speech ends', () => {
    const ep = createEndpointer(baseOpts)
    // 1s of speech — should arm but not stop
    expect(ep.feed(chunkMs(1000, LOUD)).stop).toBe(false)
    // 1.4s of silence — not enough yet
    let last = ep.feed(chunkMs(1400, QUIET))
    expect(last.stop).toBe(false)
    // crossing 1.5s total trailing silence → stop
    last = ep.feed(chunkMs(200, QUIET))
    expect(last.stop).toBe(true)
    expect(last.reason).toBe('silence')
  })

  it('stops with reason "maxlen" when speech never pauses', () => {
    const ep = createEndpointer(baseOpts)
    let res = ep.feed(chunkMs(14_000, LOUD))
    expect(res.stop).toBe(false)
    res = ep.feed(chunkMs(1000, LOUD))
    expect(res.stop).toBe(true)
    expect(res.reason).toBe('maxlen')
  })

  it('stops with reason "nospeech" when nothing is said', () => {
    const ep = createEndpointer(baseOpts)
    expect(ep.feed(chunkMs(3000, QUIET)).stop).toBe(false)
    const res = ep.feed(chunkMs(1000, QUIET))
    expect(res.stop).toBe(true)
    expect(res.reason).toBe('nospeech')
  })

  it('does not treat a sub-minSpeech blip as speech', () => {
    const ep = createEndpointer(baseOpts)
    ep.feed(chunkMs(100, LOUD)) // 100ms < minSpeechMs(300) → not "spoke"
    // long silence must NOT produce a "silence" stop (speech never armed)
    const res = ep.feed(chunkMs(2000, QUIET))
    expect(res.reason).not.toBe('silence')
  })

  it('reset() clears counters', () => {
    const ep = createEndpointer(baseOpts)
    ep.feed(chunkMs(5000, QUIET)) // would be near nospeech
    ep.reset()
    const res = ep.feed(chunkMs(100, QUIET))
    expect(res.stop).toBe(false)
  })
})
