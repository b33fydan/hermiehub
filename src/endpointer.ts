// Root-mean-square loudness of a signed-16-bit-LE mono PCM chunk, normalized to 0..1.
export function rms16(chunk: Uint8Array): number {
  const sampleCount = chunk.length >> 1
  if (sampleCount === 0) return 0
  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2)
  let sumSquares = 0
  for (let i = 0; i < sampleCount; i++) {
    const s = view.getInt16(i * 2, true) / 32768
    sumSquares += s * s
  }
  return Math.sqrt(sumSquares / sampleCount)
}

export type StopReason = 'silence' | 'maxlen' | 'nospeech'

export interface EndpointerResult {
  speaking: boolean
  stop: boolean
  reason: StopReason | null
  rms: number
}

export interface EndpointerOptions {
  sampleRate: number
  silenceRmsThreshold: number
  silenceHangoverMs: number
  minSpeechMs: number
  maxUtteranceMs: number
  leadGraceMs: number
}

export interface Endpointer {
  feed(chunk: Uint8Array): EndpointerResult
  reset(): void
}

// Decides when an utterance has ended, from the PCM stream alone. Pure: no I/O.
export function createEndpointer(opts: EndpointerOptions): Endpointer {
  let totalSamples = 0
  let trailingSilenceSamples = 0
  let speechSamples = 0
  let spoke = false

  const ms = (samples: number) => (samples / opts.sampleRate) * 1000

  return {
    feed(chunk: Uint8Array): EndpointerResult {
      const samples = chunk.length >> 1
      const rms = rms16(chunk)
      totalSamples += samples

      if (rms >= opts.silenceRmsThreshold) {
        speechSamples += samples
        trailingSilenceSamples = 0
        if (!spoke && ms(speechSamples) >= opts.minSpeechMs) spoke = true
      } else {
        trailingSilenceSamples += samples
      }

      let stop = false
      let reason: StopReason | null = null
      if (spoke && ms(trailingSilenceSamples) >= opts.silenceHangoverMs) {
        stop = true
        reason = 'silence'
      } else if (ms(totalSamples) >= opts.maxUtteranceMs) {
        stop = true
        reason = 'maxlen'
      } else if (!spoke && ms(totalSamples) >= opts.leadGraceMs) {
        stop = true
        reason = 'nospeech'
      }

      return { speaking: spoke, stop, reason, rms }
    },
    reset() {
      totalSamples = 0
      trailingSilenceSamples = 0
      speechSamples = 0
      spoke = false
    },
  }
}
