# HermieHub — Setup Guide

HermieHub is a **bring-your-own-relay** Even Realities G2 plugin. The plugin
itself is a thin WebView client; the brains (speech-to-text + your AI agent) run
on a relay *you* host. This guide gets you from zero to talking to your agent
through the glasses, hands-free.

> Heads up: this is a community/self-hosted project, not a turnkey app. You stand
> up the moving parts. If you just want to read the architecture first, see
> [README.md](README.md).

## The four moving parts

```
G2 glasses ──audio + taps──▶ HermieHub plugin (WebView)
                                   │  WebSocket  wss://<your-relay>/relay
                                   ▼
                             your relay (this repo's server/)
                               ├─ ffmpeg → whisper.cpp   (local speech-to-text)
                               └─ spawns YOUR agent CLI  → reply
                                   ▼
                             rendered on the G2 lens
```

You provide: **(1)** a machine to run the relay, **(2)** whisper.cpp + ffmpeg,
**(3)** an agent CLI, **(4)** a public `wss://` URL pointing at your relay.

## Prerequisites

- **Node 20+** (tested on 22)
- **whisper.cpp** — `brew install whisper-cpp` (the relay also accepts the
  `openai-whisper` Python CLI if that's what you have)
- **A whisper model**, e.g.:
  ```bash
  mkdir -p ~/.cache/whisper.cpp
  curl -L -o ~/.cache/whisper.cpp/ggml-base.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
- **ffmpeg** — `brew install ffmpeg`
- **An agent CLI** (see step 3 — this is the BYO part most people miss)
- An Even Realities G2 + the Even Hub companion app

## Step 1 — Clone & install

```bash
git clone https://github.com/b33fydan/hermiehub.git
cd hermiehub
npm install
```

## Step 2 — Create your relay token

The relay authenticates clients with a shared secret. Make your own — it's
gitignored, so it never leaves your machine.

```bash
cp .relay-token.example .relay-token
# edit .relay-token to a long random string, e.g.:
#   openssl rand -hex 24 > .relay-token
```

## Step 3 — Choose your agent (the BYO part)

The relay turns your transcript into a reply by **spawning an agent CLI**. Out of
the box it knows two:

- `codex` — the public OpenAI Codex CLI (a good default if you have it)
- `hermes` — the original author's personal agent ("Bernie"); **you won't have
  this** unless you build your own and put it on `PATH`

Point the relay at whatever you've got via environment variables:

```bash
export CODEX_BIN=codex                 # or an absolute path
export HERMES_BIN=/path/to/your-agent  # optional, your own agent
export HERMIE_USER_NAME="Your Name"    # how the agent addresses you (default: "the user")
```

How it's invoked lives in `runAgent()` in
[server/hermie-relay.mjs](server/hermie-relay.mjs) — adapt the spawn args there
to fit your own CLI if needed. The relay sends the agent a short, HUD-friendly
instruction plus your transcript and renders stdout back to the lens.

## Step 4 — Run the relay

```bash
npm run relay
```

On boot it prints which STT engine + model + ffmpeg it found, e.g.:

```
HermieHub Relay listening on http://localhost:8787
STT: whisper.cpp (/opt/homebrew/bin/whisper-cli)
STT model: ~/.cache/whisper.cpp/ggml-base.en.bin
ffmpeg: /opt/homebrew/bin/ffmpeg
```

If STT or ffmpeg shows "NOT FOUND", revisit the prerequisites.

**Keep it running** in its own terminal (or as a service — see "Always-on" below)
so it survives your whole session.

## Step 5 — Expose the relay over a public `wss://`

The phone (Even app) must reach your relay over a **secure public WebSocket**. The
relay listens on `:8787` locally; expose it with one of:

- **Cloudflare quick tunnel** (free, no account, good for testing — URL changes each run):
  ```bash
  cloudflared tunnel --url http://localhost:8787
  # → https://<random>.trycloudflare.com  (your relay address is this + /relay)
  ```
- **Cloudflare named tunnel** with a domain you own — a *stable* URL that survives restarts (best for real use).
- **A VPS** running the relay directly with its own domain + TLS — then no tunnel needed.

> LAN-only (`ws://<local-ip>:8787`) can work at home, but a public `wss://` is what
> makes it usable anywhere.

Also expose the dev UI if you're using dev mode (see step 6):
```bash
cloudflared tunnel --url http://localhost:5175
```

## Step 6 — Get the plugin onto the glasses

**Dev mode (fastest to iterate):**
```bash
npm run dev                                   # serves the WebView on :5175
npx evenhub qr --url https://<your-5175-tunnel>   # scan with the Even Hub app
```

**Installed plugin (permanent):**
```bash
npm run build
npm run pack        # → out.ehpk
```
Then install `out.ehpk` via the Even app's app-creation/developer flow.

## Step 7 — Connect & use

In the companion UI:
- **Address:** `wss://<your-relay-tunnel>/relay`
- **Token:** the contents of your `.relay-token`
- tap **Connect** → green dot

Then, hands-free on the glasses:

| Gesture | Action |
|---|---|
| Single tap (temple) | Start talking (auto-sends when you go quiet) |
| ~1.5s silence | Auto stop & send |
| Tap again | Stop & send now |
| Swipe up / down | Flip HUD cards |
| Double tap | Exit |

## Always-on relay (optional)

So the relay survives reboots/crashes, run it under a process manager:

```bash
# pm2
npx pm2 start npm --name hermie-relay -- run relay
npx pm2 save
```

…or a `launchd` plist on macOS. Either way it auto-restarts and you stop babysitting it.

## Tuning

All knobs are constants at the top of [src/main.ts](src/main.ts):

| Constant | Default | Fix it when… |
|---|---|---|
| `GLASSES_SAMPLE_RATE` | 16000 | transcripts are garbled (try 24000 / 48000) |
| `SILENCE_RMS_THRESHOLD` | 0.015 | it sends too early/late (watch the logged mic levels) |
| `SILENCE_HANGOVER_MS` | 1500 | you want a longer/shorter pause before it sends |
| `MAX_UTTERANCE_MS` | 15000 | you need longer single utterances |

Relay-side env vars: `HERMIE_RELAY_PORT`, `STT_INPUT_RATE`, `STT_LANG`,
`WHISPER_MODEL`, `WHISPER_BIN`, `FFMPEG_BIN`, `CODEX_BIN`, `HERMES_BIN`,
`HERMIE_USER_NAME`.

## Troubleshooting

- **"Disconnected" / won't connect** — the relay isn't running, the address/token
  is wrong, or the tunnel URL changed (quick tunnels are ephemeral). Confirm
  `curl https://<your-relay-tunnel>/health` returns `{"ok":true,...}`.
- **Tap does nothing** — make sure you're on a build with the sysEvent tap fix
  (this repo's `main.ts`); older code missed taps because protobuf omits the
  zero-valued `CLICK_EVENT`.
- **Garbled transcript** — wrong PCM sample rate; adjust `GLASSES_SAMPLE_RATE`.
- **Agent errors / "no output"** — your `CODEX_BIN`/`HERMES_BIN` isn't on `PATH`,
  or `runAgent()`'s spawn args don't match your CLI.

## Security

- `.relay-token` is your auth secret — keep it private (it's gitignored).
- A public tunnel exposes your relay to the internet; the token is the only thing
  gating it. Use a long random token, and consider a named tunnel with access
  controls for anything beyond personal use.
- STT runs locally — your audio never leaves your machine.
