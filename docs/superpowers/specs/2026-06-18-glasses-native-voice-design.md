# Glasses-Native Voice Trigger — Design Spec

**Date:** 2026-06-18
**Project:** HermieHub (`~/wearable-tech-lab/hermiehub/`)
**Status:** Approved design, pre-implementation

## Problem

Today HermieHub's voice path is triggered from the **phone** companion UI (a Voice
button in `index.html`). That makes the glasses a display for a phone app — the same
experience as typing into Telegram and reading the reply on the lens. The "wow" of
smart glasses is **hands-free, phone-in-pocket** operation: the glasses are the input
surface, not just the output.

This spec makes the agent conversation **glasses-native**: you trigger and complete a
full voice exchange with Bernie using only the glasses touchpad. The phone stays in
your pocket after first-time setup.

## Goal

Tap the temple, speak, stop talking — Bernie answers on the lens. No phone interaction.

### Non-goals (out of scope)

- Wake-word / always-listening capture.
- Server-side VAD or streaming audio architecture.
- On-lens volume meter / animated listening UI (possible later nicety).
- Changes to the relay or STT pipeline — both stay exactly as built and verified.
- Multi-turn conversation memory beyond what the agent already does.

## Locked interaction decisions

- **Talk trigger:** single tap on the temple touchpad.
- **Stop model:** auto-stop on silence (primary), with single-tap-again as a manual
  override, plus a hard max-duration safety cutoff.
- **Navigation moves to swipe** (single-tap is now exclusively the talk button).

### Gesture map

| Input | State | Action |
|---|---|---|
| Single tap (temple) | idle | Open mic, start listening |
| Single tap (temple) | listening | Stop & send immediately (manual override) |
| ~1.5s silence after speech | listening | Auto stop & send |
| Swipe up / down | any | Previous / next HUD card |
| Double tap | any | Exit app |
| App backgrounded (`FOREGROUND_EXIT_EVENT`) | listening | Stop mic, return to idle |

SDK constraint: only discrete gestures exist (`CLICK_EVENT`, `DOUBLE_CLICK_EVENT`,
`SCROLL_TOP_EVENT`, `SCROLL_BOTTOM_EVENT`). There is **no press-and-hold event**, so
hold-to-talk is impossible; tap-to-start is required.

## Architecture

**Client-only change.** All work lives in [src/main.ts](../../../src/main.ts). The
relay (`server/hermie-relay.mjs`) and the whisper.cpp STT pipeline are untouched — the
client still sends the same `{ type: 'voice', agent, rate, pcm }` message the relay
already handles. No new dependencies.

Three concerns, separated:

1. **Endpointer** — a pure function/module that decides when an utterance has ended,
   based purely on the PCM stream. No DOM, no SDK, no I/O. Independently unit-testable.
2. **Capture controller** — wires the Even bridge (`audioControl`, `onEvenHubEvent`)
   to the endpointer and to the relay send. Owns the listening state machine.
3. **Gesture router** — maps `onEvenHubEvent` gestures to capture/navigation actions.

### Endpointer (pure, testable)

Interface:

```
createEndpointer(opts) -> {
  feed(chunk: Uint8Array): { speaking: boolean, stop: boolean, reason: StopReason | null }
  reset(): void
}
```

- Interprets each chunk as signed 16-bit little-endian mono PCM and computes RMS,
  normalized to 0..1 (divide by 32768).
- Tracks duration by **counting samples** (not wall-clock — robust to event-cadence
  jitter), converting to milliseconds as `samples / sampleRate * 1000`:
  `totalMs`, `trailingSilenceMs`, and whether speech has occurred (`spoke` once
  cumulative above-threshold audio exceeds `MIN_SPEECH_MS`).
- `stop = true` when:
  - `spoke && trailingSilenceMs ≥ SILENCE_HANGOVER_MS` → reason `silence`, or
  - `totalMs ≥ MAX_UTTERANCE_MS` → reason `maxlen`, or
  - `!spoke && totalMs ≥ LEAD_GRACE_MS` → reason `nospeech` (caller cancels, no send).
- `reset()` clears all counters for the next utterance.

### Capture flow

```
tap (idle):
  endpointer.reset(); pcmChunks = []; audioControl(true); state = listening
  HUD: "🎤 LISTENING — pause when you're done"

audioEvent chunk (while listening):
  bytes = normalize(audioPcm)            // Uint8Array | number[] | base64
  pcmChunks.push(bytes)
  { speaking, stop, reason } = endpointer.feed(bytes)
  log RMS/state (throttled, ~every 400ms) to companion log
  if stop:
    if reason == 'nospeech': cancelListening("Didn't hear anything")
    else: stopAndSend()

tap (listening) OR backgrounded:
  stopAndSend()                          // manual override / hygiene

stopAndSend():
  audioControl(false); state = processing
  pcm = concat(pcmChunks)
  send { type:'voice', agent, rate: GLASSES_SAMPLE_RATE, pcm: base64(pcm) }
```

Relay replies flow through the existing `handleRelayMessage` path
(`transcribing` → `transcript` → `agent_started` → `agent_result`), which already
renders to the lens and resets to idle on `agent_result`.

## Tunable constants (defaults)

| Constant | Default | Purpose |
|---|---|---|
| `GLASSES_SAMPLE_RATE` | 16000 | Assumed PCM rate; matches relay |
| `SILENCE_RMS_THRESHOLD` | 0.015 | Normalized loudness below which a window is "silent" |
| `SILENCE_HANGOVER_MS` | 1500 | Continuous silence after speech that ends the utterance |
| `MIN_SPEECH_MS` | 300 | Above-threshold audio required before auto-stop can arm |
| `MAX_UTTERANCE_MS` | 15000 | Hard cutoff — utterance always sends, never hangs |
| `LEAD_GRACE_MS` | 4000 | If no speech by now, cancel quietly |

All are named constants at the top of `main.ts`, tunable without touching logic.

## Error handling & graceful degradation

- `audioControl(true)` returns false / throws → "MIC BLOCKED" lens message, back to idle.
- No PCM captured on stop → "No audio captured" log, back to idle (no send).
- Silence detection mis-tuned on first hardware run → **manual tap-stop always works**
  and **`MAX_UTTERANCE_MS` guarantees a send**. The feature never traps the user.
- Relay disconnected → existing "Not connected" guard; voice trigger inert until connected.

## Observability (de-risks the hardware unknown)

The single unverified assumption is that the glasses stream 16 kHz / 16-bit / mono PCM.
To make that tunable rather than a black box, the app logs (throttled) to the companion
log during listening: rolling RMS, `speaking` flag, trailing-silence ms, and the stop
`reason`. First time on-device, we read those numbers and adjust `SILENCE_RMS_THRESHOLD`
(and `GLASSES_SAMPLE_RATE` if transcripts are garbled) in seconds.

## Testing strategy

- **Endpointer: unit tests, no hardware.** Feed synthetic PCM — pure silence, steady
  tone, speech-then-silence, speech-exceeding-max, tap-but-no-speech — and assert the
  `stop`/`reason` transitions. This proves the core logic before the glasses exist.
- **Capture/gesture wiring:** verified on-device (the only part needing the glasses).
- **Regression:** typed "Send to Agent" path and relay round-trip remain unchanged
  (already verified end-to-end).

## On-device verification plan

1. Connect relay (already running on the Mac mini), reload app on glasses.
2. Tap temple → confirm "🎤 LISTENING" on lens and `audioControl` success in log.
3. Speak a short command, stop → watch for `Captured N bytes` and a `transcript`.
4. Confirm Bernie's reply renders on the lens — **phone never touched.**
5. If transcript garbled → adjust `GLASSES_SAMPLE_RATE`. If auto-stop too eager/slow →
   adjust `SILENCE_RMS_THRESHOLD` / `SILENCE_HANGOVER_MS` using logged RMS values.

## Risks

- **PCM format assumption** (rate/bit-depth/endianness). Mitigated by logging + tunables
  + manual stop + max cutoff. Worst case: manual tap-to-stop still delivers the feature.
- **Touchpad event source** (which temple, accidental taps). Single-tap-to-talk is
  simple and forgiving; double-tap-exit is distinct. If accidental taps prove common,
  a future option is requiring a specific `EventSourceType`.
