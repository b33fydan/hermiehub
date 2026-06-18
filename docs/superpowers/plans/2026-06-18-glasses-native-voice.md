# Glasses-Native Voice Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user trigger and complete a full voice exchange with Bernie using only the glasses temple touchpad — tap to talk, auto-send when they stop speaking — phone in pocket.

**Architecture:** Client-only change to HermieHub. A new pure `endpointer` module decides when an utterance ends from the PCM stream (unit-tested with synthetic audio). `main.ts` wires the Even bridge (`audioControl` + `onEvenHubEvent` audio chunks) to the endpointer, rebinds single-tap to talk and swipe to navigate, and reuses the existing relay `{type:'voice'}` path unchanged.

**Tech Stack:** TypeScript, Vite, `@evenrealities/even_hub_sdk`, Vitest (new dev-only test runner). Relay (`server/hermie-relay.mjs`) and whisper.cpp STT untouched.

> **GIT NOTE:** This project is not a git repository yet. Run `git init` once in `~/wearable-tech-lab/hermiehub` if you want the `git commit` steps to work; otherwise treat each **Commit** step as a checkpoint (verify the listed state, then continue).

---

## File Structure

- **Create** `src/endpointer.ts` — pure utterance-endpointing module: `rms16()` (loudness of a PCM chunk) and `createEndpointer()` (silence/maxlen/nospeech state machine). No DOM, no SDK, no I/O.
- **Create** `src/endpointer.test.ts` — Vitest unit tests for the above.
- **Modify** `src/main.ts` — rebind gestures, feed audio chunks to the endpointer, auto-stop/cancel, swipe navigation, listening HUD text, throttled level logging.
- **Modify** `package.json` — add Vitest dev dependency and `test` script.

---

## Task 1: Add Vitest test runner

**Files:**
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the test script**

In `package.json`, add a `test` entry to `scripts` (place it after the `"build"` line):

```json
    "test": "vitest run",
```

- [ ] **Step 2: Install Vitest (dev-only)**

Run: `cd ~/wearable-tech-lab/hermiehub && npm install -D vitest`
Expected: installs without errors; `vitest` appears under `devDependencies`.

- [ ] **Step 3: Verify Vitest is available**

Run: `npx vitest --version`
Expected: prints a version number (e.g. `3.x.x`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest for unit tests"
```

---

## Task 2: `rms16` — loudness of a PCM chunk (TDD)

**Files:**
- Create: `src/endpointer.ts`
- Test: `src/endpointer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/endpointer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rms16 } from './endpointer'

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/endpointer.test.ts`
Expected: FAIL — cannot resolve `./endpointer` / `rms16` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/endpointer.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/endpointer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/endpointer.ts src/endpointer.test.ts
git commit -m "feat: add rms16 PCM loudness helper"
```

---

## Task 3: `createEndpointer` — utterance end detection (TDD)

**Files:**
- Modify: `src/endpointer.ts`
- Modify: `src/endpointer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/endpointer.test.ts` (after the existing `describe`/export):

```ts
import { createEndpointer } from './endpointer'

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
    // 1.4s of silence in 100ms windows — not enough yet
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/endpointer.test.ts`
Expected: FAIL — `createEndpointer` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/endpointer.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/endpointer.test.ts`
Expected: PASS (all `rms16` + `createEndpointer` tests).

- [ ] **Step 5: Commit**

```bash
git add src/endpointer.ts src/endpointer.test.ts
git commit -m "feat: add utterance endpointer (silence/maxlen/nospeech)"
```

---

## Task 4: Wire the endpointer + new gestures into `main.ts`

**Files:**
- Modify: `src/main.ts`

All edits below are exact string replacements against the current `src/main.ts`.

- [ ] **Step 1: Import the endpointer**

Replace the SDK import block's closing with an added import. Find:

```ts
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
```

Replace with:

```ts
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { createEndpointer, type EndpointerResult } from './endpointer'
```

- [ ] **Step 2: Add silence-detection constants**

Find:

```ts
const GLASSES_SAMPLE_RATE = 16_000
```

Replace with:

```ts
const GLASSES_SAMPLE_RATE = 16_000

// Auto-stop tuning. Adjust these using the rms values logged during listening.
const SILENCE_RMS_THRESHOLD = 0.015 // normalized loudness below which a window is "silent"
const SILENCE_HANGOVER_MS = 1500 // silence after speech that ends the utterance
const MIN_SPEECH_MS = 300 // speech required before auto-stop can arm
const MAX_UTTERANCE_MS = 15_000 // hard cutoff — always sends, never hangs
const LEAD_GRACE_MS = 4000 // if no speech by now, cancel quietly
```

- [ ] **Step 3: Create the endpointer instance + level-log throttle**

Find:

```ts
// Captured glasses-mic audio between audioControl(true) and audioControl(false).
let pcmChunks: Uint8Array[] = []
```

Replace with:

```ts
// Captured glasses-mic audio between audioControl(true) and audioControl(false).
let pcmChunks: Uint8Array[] = []

const endpointer = createEndpointer({
  sampleRate: GLASSES_SAMPLE_RATE,
  silenceRmsThreshold: SILENCE_RMS_THRESHOLD,
  silenceHangoverMs: SILENCE_HANGOVER_MS,
  minSpeechMs: MIN_SPEECH_MS,
  maxUtteranceMs: MAX_UTTERANCE_MS,
  leadGraceMs: LEAD_GRACE_MS,
})

let lastLevelLogMs = 0
function maybeLogLevel(r: EndpointerResult) {
  const now = Date.now()
  if (now - lastLevelLogMs < 400) return
  lastLevelLogMs = now
  appendLog(`mic rms=${r.rms.toFixed(3)} ${r.speaking ? 'speech' : 'quiet'}`)
}
```

- [ ] **Step 4: Update the listening HUD text + card hints**

Find:

```ts
    lastHud = '🎤 LISTENING\nSpeak now.\nTap Voice again to send.'
```

Replace with:

```ts
    lastHud = '🎤 LISTENING\nSpeak now — I send\nwhen you go quiet.'
```

Then find:

```ts
    'Voice: ${voiceAvailable() ? 'glasses mic ready' : bridgeReady ? 'connect relay' : 'waiting for bridge'}\n' +
    'Tap cycles cards. Double-tap exits.',
```

Replace with:

```ts
    'Voice: ${voiceAvailable() ? 'glasses mic ready' : bridgeReady ? 'connect relay' : 'waiting for bridge'}\n' +
    'Tap = talk. Swipe = cards. Double-tap exits.',
```

Then find:

```ts
    '1. Connect relay\n' +
    '2. Tap Voice, speak, tap again\n' +
    '3. Bernie replies on lens\n' +
    'Or type + Send to Agent',
```

Replace with:

```ts
    '1. Connect relay\n' +
    '2. Tap temple, just talk\n' +
    '3. Bernie replies on lens\n' +
    'Swipe to flip cards',
```

- [ ] **Step 5: Reset the endpointer when listening starts**

Find:

```ts
  pcmChunks = []
  try {
    const ok = await bridge.audioControl(true)
```

Replace with:

```ts
  pcmChunks = []
  endpointer.reset()
  lastLevelLogMs = 0
  try {
    const ok = await bridge.audioControl(true)
```

- [ ] **Step 6: Add `cancelListening` (no-send path)**

Find:

```ts
function toggleVoice() {
```

Replace with:

```ts
// End listening without sending (e.g. user said nothing).
async function cancelListening(note: string) {
  try { await bridge?.audioControl(false) } catch { /* best effort */ }
  pcmChunks = []
  appendLog(note)
  lastHud = `NO INPUT\n${note}`
  cardIndex = 0
  setVoiceState('idle')
  rebuildHud().catch(console.error)
}

function toggleVoice() {
```

- [ ] **Step 7: Feed audio chunks to the endpointer and auto-stop**

Find:

```ts
    // Glasses microphone audio (PCM) streamed while listening.
    if (event.audioEvent && voiceState === 'listening') {
      const bytes = toBytes(event.audioEvent.audioPcm as unknown)
      if (bytes && bytes.length) pcmChunks.push(bytes)
      return
    }
```

Replace with:

```ts
    // Glasses microphone audio (PCM) streamed while listening.
    if (event.audioEvent && voiceState === 'listening') {
      const bytes = toBytes(event.audioEvent.audioPcm as unknown)
      if (bytes && bytes.length) {
        pcmChunks.push(bytes)
        const r = endpointer.feed(bytes)
        maybeLogLevel(r)
        if (r.stop) {
          if (r.reason === 'nospeech') {
            cancelListening("Didn't hear anything. Tap to try again.").catch(console.error)
          } else {
            stopListening().catch(console.error)
          }
        }
      }
      return
    }
```

- [ ] **Step 8: Rebind gestures — tap talks, swipe navigates, background stops mic**

Find:

```ts
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      cardIndex = (cardIndex + 1) % cards.length
      rebuildHud().catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
```

Replace with:

```ts
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      toggleVoice()
      return
    }

    if (sysType === OsEventTypeList.SCROLL_TOP_EVENT || textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      cardIndex = (cardIndex - 1 + cards.length) % cards.length
      rebuildHud().catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT || textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      cardIndex = (cardIndex + 1) % cards.length
      rebuildHud().catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      if (voiceState === 'listening') {
        bridge?.audioControl(false).catch(console.error)
        pcmChunks = []
        setVoiceState('idle')
      }
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
```

- [ ] **Step 9: Type-check and build**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run build`
Expected: PASS — `tsc --noEmit` reports no errors (strict, noUnusedLocals), vite build succeeds.

- [ ] **Step 10: Run the unit tests once more (no regressions)**

Run: `npm test`
Expected: PASS — all endpointer tests green.

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "feat: glasses-native voice — tap to talk, auto-stop on silence, swipe to navigate"
```

---

## Task 5: Repackage and stage for device test

**Files:**
- Modify: `out.ehpk` (regenerated)

- [ ] **Step 1: Repack the Even Hub plugin**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run pack`
Expected: `Successfully packed out.ehpk (... bytes)`.

- [ ] **Step 2: Confirm the relay is still running the verified voice path**

Run: `curl -s http://localhost:8787/health`
Expected: `{"ok":true,...}`. (No relay change in this plan — STT path already verified.)

- [ ] **Step 3: On-device verification (manual, requires glasses)**

1. Reload HermieHub on the glasses (served via the vite tunnel) or reinstall `out.ehpk`.
2. Single-tap the temple → lens shows `🎤 LISTENING` and the companion log shows `Glasses mic open`.
3. Speak a short command, then pause. Watch the log for `mic rms=...` lines, then `Captured N bytes`, then a `transcript`, then Bernie's reply on the lens.
4. Confirm the phone was never touched.
5. **Tuning:** if it auto-sends too early/late, adjust `SILENCE_RMS_THRESHOLD` / `SILENCE_HANGOVER_MS` using the logged rms values. If the transcript is garbled, adjust `GLASSES_SAMPLE_RATE`. Rebuild + reload after changes.

- [ ] **Step 4: Commit any tuning changes**

```bash
git add src/main.ts out.ehpk
git commit -m "chore: repack ehpk; tune voice thresholds for device"
```

---

## Self-Review

**Spec coverage:**
- Single-tap talk trigger → Task 4 Step 8 (CLICK → `toggleVoice`). ✓
- Auto-stop on silence + manual tap-again + max cutoff → Task 3 (endpointer reasons) + Task 4 Step 7. ✓
- Swipe navigation → Task 4 Step 8 (SCROLL_TOP/BOTTOM). ✓
- Double-tap exit / background hygiene → existing double-tap handler kept; FOREGROUND_EXIT added Task 4 Step 8. ✓
- Pure, unit-tested endpointer → Tasks 2–3. ✓
- Tunable constants → Task 4 Step 2. ✓
- Observability (throttled rms logging) → Task 4 Step 3 + Step 7. ✓
- Relay/STT untouched, client-only → confirmed (only `src/`, `package.json`, `out.ehpk`). ✓
- Graceful degradation (manual stop + maxlen) → endpointer `maxlen` + tap override. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `EndpointerResult`, `createEndpointer`, `rms16`, `feed`, `reset` used identically across Tasks 2–4. `maybeLogLevel(r: EndpointerResult)` matches the exported type. `r.reason === 'nospeech'` matches `StopReason`.
