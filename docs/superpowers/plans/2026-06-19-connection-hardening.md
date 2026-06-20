# Connection Hardening (Heartbeat + Stuck Recovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the WebSocket from silently dropping (and stop dead sockets piling up on the relay), and make sure a lost agent reply can never leave the app stuck in "Sending…".

**Architecture:** Two complementary parts. (A) A heartbeat: the relay pings each socket every 30s and terminates ones that stop ponging (reaps dead/half-open sockets + keeps live ones warm through the tunnel); the client sends an app-level `{type:'ping'}` every 25s and proactively reconnects if the relay goes silent. (B) Stuck recovery: the client resets `processing`→`idle` when the socket drops mid-reply, with a long no-activity timeout as a backstop. Root cause was confirmed in debugging: drops are ongoing (relay reconnect-pairs in the log) and `setVoiceState('idle')` only runs on `agent_result`, so a lost reply hangs forever.

**Tech Stack:** TypeScript, Vite, Vitest, `ws` (relay). Verification is primarily via the live relay log + on-device, since this is timer/WebSocket integration code; one pure helper is unit-tested.

---

## File Structure

- **Modify** `server/hermie-relay.mjs` — protocol ping/pong heartbeat + dead-socket reaping.
- **Create** `src/heartbeat.ts` — `isConnectionStale()` (pure, testable threshold helper).
- **Create** `src/heartbeat.test.ts` — vitest unit test.
- **Modify** `src/main.ts` — client heartbeat + silence watchdog (uses `isConnectionStale`); reset-on-drop and a processing no-activity watchdog.

---

## Task 1: Relay heartbeat + dead-socket reaping

**Files:**
- Modify: `server/hermie-relay.mjs`

- [ ] **Step 1: Add the heartbeat interval after the WebSocketServer is created**

Find:

```js
const wss = new WebSocketServer({ noServer: true })
```

Replace with:

```js
const wss = new WebSocketServer({ noServer: true })

const HEARTBEAT_MS = Number(process.env.HERMIE_HEARTBEAT_MS || 30_000)

// Reap dead/half-open sockets and keep live ones warm through the tunnel.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try { ws.ping() } catch { /* socket already gone */ }
  }
}, HEARTBEAT_MS)
wss.on('close', () => clearInterval(heartbeat))
```

- [ ] **Step 2: Mark each connection alive and refresh on pong**

Find:

```js
wss.on('connection', (ws, req) => {
  clients.add(ws)
```

Replace with:

```js
wss.on('connection', (ws, req) => {
  clients.add(ws)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
```

- [ ] **Step 3: Syntax check**

Run: `cd ~/wearable-tech-lab/hermiehub && node --check server/hermie-relay.mjs`
Expected: no output (parses clean).

- [ ] **Step 4: Boot on a test port and confirm it still serves**

Run: `cd ~/wearable-tech-lab/hermiehub && HERMIE_RELAY_PORT=8790 node server/hermie-relay.mjs & sleep 1 && curl -s http://localhost:8790/health && echo && kill %1`
Expected: `{"ok":true,...}` then the test relay is killed.

- [ ] **Step 5: Commit**

```bash
git add server/hermie-relay.mjs
git commit -m "feat(relay): ping/pong heartbeat + dead-socket reaping"
```

---

## Task 2: `isConnectionStale` helper (TDD)

**Files:**
- Create: `src/heartbeat.ts`
- Test: `src/heartbeat.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/heartbeat.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/heartbeat.test.ts`
Expected: FAIL — cannot resolve `./heartbeat`.

- [ ] **Step 3: Write the implementation**

Create `src/heartbeat.ts`:

```ts
// True when no message has been seen for longer than silenceMs — the socket is
// presumed dead (e.g. a half-open connection that never fired 'close').
export function isConnectionStale(lastMessageAt: number, now: number, silenceMs: number): boolean {
  return now - lastMessageAt > silenceMs
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/heartbeat.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat.ts src/heartbeat.test.ts
git commit -m "feat: add isConnectionStale heartbeat helper"
```

---

## Task 3: Client heartbeat + silence watchdog

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Import the helper**

Find:

```ts
import { chatEntryFromRelay, type ChatEntry } from './chatlog'
```

Replace with:

```ts
import { chatEntryFromRelay, type ChatEntry } from './chatlog'
import { isConnectionStale } from './heartbeat'
```

- [ ] **Step 2: Add heartbeat constants**

Find:

```ts
const MAX_RECONNECT_ATTEMPTS = 10 // give up auto-reconnect after this many tries
```

Replace with:

```ts
const MAX_RECONNECT_ATTEMPTS = 10 // give up auto-reconnect after this many tries
const CLIENT_HEARTBEAT_MS = 25_000 // app-level ping cadence (under the tunnel's ~100s idle cap)
const RELAY_SILENCE_MS = 40_000 // no message for this long → treat the socket as dead
const PROCESSING_TIMEOUT_MS = 150_000 // give up waiting for a reply after this (> max STT+agent time)
```

- [ ] **Step 3: Add heartbeat state variables**

Find:

```ts
let lastWsUrl: string | null = null
```

Replace with:

```ts
let lastWsUrl: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastRelayMessageAt = 0
let processingTimer: ReturnType<typeof setTimeout> | null = null
```

- [ ] **Step 4: Add the heartbeat start/stop functions**

Find:

```ts
function clearReconnect() {
```

Insert immediately before it:

```ts
function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function startHeartbeat() {
  stopHeartbeat()
  lastRelayMessageAt = Date.now()
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (isConnectionStale(lastRelayMessageAt, Date.now(), RELAY_SILENCE_MS)) {
      appendLog('No heartbeat from relay — reconnecting.')
      socket.close() // triggers the reconnect path in the close handler
      return
    }
    sendSocket({ type: 'ping' })
  }, CLIENT_HEARTBEAT_MS)
}

```

- [ ] **Step 5: Wire heartbeat into the socket lifecycle**

Find:

```ts
  socket.addEventListener('open', () => {
    reconnectAttempts = 0
    setRelayState('connected')
    appendLog('Relay connected.')
    sendSocket({ type: 'ping' })
  })
  socket.addEventListener('message', event => {
    try { handleRelayMessage(JSON.parse(String(event.data))) }
    catch { appendLog(`raw: ${String(event.data)}`) }
  })
```

Replace with:

```ts
  socket.addEventListener('open', () => {
    reconnectAttempts = 0
    setRelayState('connected')
    appendLog('Relay connected.')
    startHeartbeat()
    sendSocket({ type: 'ping' })
  })
  socket.addEventListener('message', event => {
    lastRelayMessageAt = Date.now()
    try { handleRelayMessage(JSON.parse(String(event.data))) }
    catch { appendLog(`raw: ${String(event.data)}`) }
  })
```

- [ ] **Step 6: Type-check and build**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run build`
Expected: `tsc` clean, vite build succeeds. (`stopHeartbeat` is wired up fully in Task 4; it is referenced by `startHeartbeat` already so there are no unused-symbol errors.)

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat(client): app-level heartbeat + silence watchdog"
```

---

## Task 4: Stuck-state recovery (reset-on-drop + processing watchdog)

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add the processing watchdog functions**

Find:

```ts
function stopHeartbeat() {
```

Insert immediately before it:

```ts
function clearProcessingWatchdog() {
  if (processingTimer) {
    clearTimeout(processingTimer)
    processingTimer = null
  }
}

function armProcessingWatchdog() {
  clearProcessingWatchdog()
  processingTimer = setTimeout(() => {
    if (voiceState !== 'processing') return
    appendLog('No response from the agent — reset.')
    lastHud = 'NO RESPONSE\nAgent went quiet.\nTap to try again.'
    setVoiceState('idle')
    rebuildHud().catch(console.error)
  }, PROCESSING_TIMEOUT_MS)
}

```

- [ ] **Step 2: Arm/clear the watchdog from setVoiceState**

Find:

```ts
function setVoiceState(next: VoiceState) {
  voiceState = next
  if (next === 'listening') {
```

Replace with:

```ts
function setVoiceState(next: VoiceState) {
  voiceState = next
  if (next === 'processing') armProcessingWatchdog()
  else clearProcessingWatchdog()
  if (next === 'listening') {
```

- [ ] **Step 3: Re-arm the watchdog on relay activity**

Find:

```ts
  const chatEntry = chatEntryFromRelay(msg)
  if (chatEntry) appendChat(chatEntry)
```

Replace with:

```ts
  const chatEntry = chatEntryFromRelay(msg)
  if (chatEntry) appendChat(chatEntry)

  // Any message while processing is proof of life — push the no-response timeout out.
  if (voiceState === 'processing') armProcessingWatchdog()
```

- [ ] **Step 4: Reset on a drop that happens mid-reply**

Find:

```ts
  socket.addEventListener('close', () => {
    socket = null
    if (userClosed) {
      setRelayState('disconnected')
      appendLog('Relay disconnected.')
      return
    }
    scheduleReconnect()
  })
```

Replace with:

```ts
  socket.addEventListener('close', () => {
    socket = null
    stopHeartbeat()
    if (voiceState === 'processing') {
      appendLog('Connection dropped while waiting for a reply — reset.')
      lastHud = 'CONNECTION HICCUP\nReply was lost.\nTap to try again.'
      setVoiceState('idle')
      rebuildHud().catch(console.error)
    }
    if (userClosed) {
      setRelayState('disconnected')
      appendLog('Relay disconnected.')
      return
    }
    scheduleReconnect()
  })
```

- [ ] **Step 5: Type-check, build, and run the full test suite**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run build && npm test`
Expected: `tsc` clean (strict, noUnusedLocals — `stopHeartbeat`, `armProcessingWatchdog`, `clearProcessingWatchdog`, `isConnectionStale` all referenced), vite build succeeds, all tests pass (endpointer + reconnect + chatlog + heartbeat).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(client): recover from a dropped/silent reply instead of hanging in Sending"
```

---

## Task 5: Deploy, repack, and verify against the live relay

**Files:**
- Modify: `out.ehpk` (regenerated)

- [ ] **Step 1: Repack**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run pack`
Expected: `Successfully packed out.ehpk (... bytes)`.

- [ ] **Step 2: Restart the live relay with the heartbeat code**

Run: `cd ~/wearable-tech-lab/hermiehub && npx pm2 restart hermie-relay && sleep 1 && curl -s http://localhost:8787/health && echo`
Expected: relay restarts, health returns `{"ok":true,...}`.

- [ ] **Step 3: Verify against the relay log (the self-confirming check)**

Reload the app and use it for a few minutes, then run:
`tail -40 ~/.pm2/logs/hermie-relay-out.log`
Expected: the tight drop→reconnect connection pairs (two "client connected" lines ~1s apart) should **no longer appear**, and the open-client count should stay low (1–2), not climb. This confirms the heartbeat fixed the drops.

- [ ] **Step 4: On-device verification (manual)**

1. Have a normal voice + typed conversation — confirm replies still arrive (no regression).
2. Mid-reply, kill the relay briefly (`npx pm2 restart hermie-relay`) → confirm the app does **not** hang in "Sending…": it shows the "connection hiccup" note and returns to idle, then reconnects.
3. Leave it connected and idle for ~3 minutes → confirm it stays connected (no silent drop).

- [ ] **Step 5: Commit**

```bash
git add out.ehpk
git commit -m "chore: repack ehpk with connection hardening"
```

(Note: `out.ehpk` is gitignored, so this commit is a no-op checkpoint; the artifact stays local.)

---

## Self-Review

**Coverage of the approved design:**
- Relay ping/pong heartbeat + reaping → Task 1. ✓
- Client app-level heartbeat (25s) + proactive reconnect on silence (40s) → Task 3 (uses `isConnectionStale` from Task 2). ✓
- Reset processing→idle on a mid-reply drop → Task 4 Step 4. ✓
- No-activity processing backstop (150s, re-armed on every message so slow STT/agent isn't cut off) → Task 4 Steps 1–3. ✓
- Self-confirming verification via relay log → Task 5 Step 3. ✓
- No regression to existing 19 tests → Task 4 Step 5. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `isConnectionStale(lastMessageAt, now, silenceMs)` signature matches its call in `startHeartbeat`. Timer vars typed `ReturnType<typeof setInterval>` / `ReturnType<typeof setTimeout>`. `armProcessingWatchdog`/`clearProcessingWatchdog`/`startHeartbeat`/`stopHeartbeat` are function declarations (hoisted), referenced consistently. `voiceState`/`setVoiceState`/`lastHud`/`rebuildHud` already exist in `main.ts`.
```
