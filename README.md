# HermieHub

Talk to an AI agent (Hermes/"Bernie" or Codex) **hands-free through Even Realities G2
glasses**. Tap the temple, speak, and the reply renders on the lens — phone stays in
your pocket.

It's an Even Hub WebView plugin paired with a local WebSocket relay. The glasses
capture audio, a relay on your machine transcribes it locally with **whisper.cpp** and
runs your agent, and the answer comes back to the lens.

## How it works

```
G2 glasses  ──audio(PCM)/gestures──▶  WebView plugin (index.html + src/main.ts)
                                           │  WebSocket {type:'voice', pcm}
                                           ▼
                                   relay (server/hermie-relay.mjs)
                                     ├─ ffmpeg → whisper.cpp  (local STT)
                                     └─ spawns `hermes` / `codex`  → reply
                                           │  {type:'agent_result'}
                                           ▼
                                     rendered on the G2 lens
```

The glasses mic is **only** reachable through the Even SDK bridge
(`bridge.audioControl()` + `audioEvent` PCM), not browser `getUserMedia` — that path is
blocked inside the WebView regardless of OS permissions. Speech-to-text runs on your own
machine; audio never leaves it.

## Glasses controls

| Gesture | Action |
|---|---|
| Single tap (temple) | Start talking (auto-sends when you go quiet) / stop now |
| Swipe up / down | Flip HUD cards |
| Double tap | Exit |

Listening auto-stops ~1.5s after you stop speaking (tunable). No press-and-hold — the
SDK only emits discrete gestures.

## Prerequisites

- Node 20+ (tested on 22)
- [`whisper-cpp`](https://github.com/ggml-org/whisper.cpp) — `brew install whisper-cpp`
  (the relay falls back to `openai-whisper` if present)
- A whisper model, e.g. `~/.cache/whisper.cpp/ggml-base.en.bin`
- `ffmpeg` — `brew install ffmpeg`
- An agent CLI on PATH: `hermes` and/or `codex`

## Setup

```bash
npm install

# create your relay auth token (kept out of git)
cp .relay-token.example .relay-token
# then edit .relay-token to a long random secret

npm run relay      # start the WebSocket relay (port 8787)
npm run dev        # serve the WebView UI (port 5175)
```

In the companion UI, enter the relay address (`wss://…/relay`, e.g. via a Cloudflare
tunnel) and your token, connect, then drive it from the glasses.

## Build & package

```bash
npm test           # endpointer unit tests (vitest)
npm run build      # type-check + production build
npm run pack       # produce out.ehpk for Even Hub
```

## Layout

| Path | Purpose |
|---|---|
| `src/main.ts` | G2 app: relay client, gesture routing, glasses-mic capture |
| `src/endpointer.ts` | Pure silence-detection (utterance endpointing), unit-tested |
| `server/hermie-relay.mjs` | WebSocket relay: local whisper.cpp STT + agent spawning |
| `index.html` | Companion WebView UI (setup + log) |
| `app.json` | Even Hub manifest (network + microphone permissions) |
| `docs/superpowers/` | Design spec + implementation plan |

## Tuning voice

If auto-stop is too eager/slow, or transcripts come back garbled, adjust the constants
at the top of `src/main.ts` (`SILENCE_RMS_THRESHOLD`, `SILENCE_HANGOVER_MS`,
`GLASSES_SAMPLE_RATE`). The companion log prints live mic levels while listening.
