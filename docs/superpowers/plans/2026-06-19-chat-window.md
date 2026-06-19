# Companion Chat Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scrollable, session-only conversation thread to the HermieHub phone companion UI, above the existing debug log.

**Architecture:** Client-only. A pure mapper (`src/chatlog.ts`) turns a relay message into a chat entry (or null); `main.ts` renders user/agent bubbles into a new `#chat` panel from that mapper plus typed sends. No relay/STT changes, no persistence, no new dependencies.

**Tech Stack:** TypeScript, Vite, Vitest. Existing relay messages (`transcript`, `agent_result`).

---

## File Structure

- **Create** `src/chatlog.ts` — `agentLabel()` + `chatEntryFromRelay()` (pure, no DOM).
- **Create** `src/chatlog.test.ts` — Vitest unit tests for the mapper.
- **Modify** `index.html` — `#chat` panel markup (above `#log`) + bubble styles.
- **Modify** `src/main.ts` — `#chat` ref, `appendChat()` renderer, hook into `handleRelayMessage` + a typed-send handler.

---

## Task 1: `chatlog` mapper (TDD)

**Files:**
- Create: `src/chatlog.ts`
- Test: `src/chatlog.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/chatlog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { chatEntryFromRelay, agentLabel } from './chatlog'

describe('agentLabel', () => {
  it('maps known sources to friendly names', () => {
    expect(agentLabel('hermes')).toBe('Bernie')
    expect(agentLabel('codex')).toBe('Codex')
    expect(agentLabel('demo')).toBe('Demo')
  })
  it('uppercases unknown sources and defaults to Agent', () => {
    expect(agentLabel('foo')).toBe('FOO')
    expect(agentLabel(undefined)).toBe('Agent')
  })
})

describe('chatEntryFromRelay', () => {
  it('maps a transcript to a user entry', () => {
    expect(chatEntryFromRelay({ type: 'transcript', text: 'hello there' }))
      .toEqual({ role: 'user', text: 'hello there' })
  })
  it('maps a successful agent_result to a labeled agent entry', () => {
    expect(chatEntryFromRelay({ type: 'agent_result', ok: true, source: 'hermes', text: 'hi Dan' }))
      .toEqual({ role: 'agent', label: 'Bernie', text: 'hi Dan' })
  })
  it('returns null for a failed agent_result', () => {
    expect(chatEntryFromRelay({ type: 'agent_result', ok: false, source: 'hermes', text: 'boom' }))
      .toBeNull()
  })
  it('returns null for empty text', () => {
    expect(chatEntryFromRelay({ type: 'transcript', text: '   ' })).toBeNull()
    expect(chatEntryFromRelay({ type: 'agent_result', ok: true, text: '' })).toBeNull()
  })
  it('returns null for status/unknown messages', () => {
    expect(chatEntryFromRelay({ type: 'agent_started', message: 'cooking' })).toBeNull()
    expect(chatEntryFromRelay({ type: 'pong' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/chatlog.test.ts`
Expected: FAIL — cannot resolve `./chatlog`.

- [ ] **Step 3: Write the implementation**

Create `src/chatlog.ts`:

```ts
export type ChatRole = 'user' | 'agent'

export interface ChatEntry {
  role: ChatRole
  label?: string
  text: string
}

export interface RelayLike {
  type?: string
  text?: string
  ok?: boolean
  source?: string
}

// Friendly display name for an agent source.
export function agentLabel(source?: string): string {
  if (source === 'hermes') return 'Bernie'
  if (source === 'codex') return 'Codex'
  if (source === 'demo') return 'Demo'
  return source ? source.toUpperCase() : 'Agent'
}

// Map a relay message to a chat entry, or null if it should not appear in the
// conversation thread (status, errors, unknown types, empty text).
export function chatEntryFromRelay(msg: RelayLike): ChatEntry | null {
  const text = (msg.text ?? '').trim()
  if (msg.type === 'transcript') {
    return text ? { role: 'user', text } : null
  }
  if (msg.type === 'agent_result' && msg.ok === true) {
    return text ? { role: 'agent', label: agentLabel(msg.source), text } : null
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/chatlog.test.ts`
Expected: PASS (all agentLabel + chatEntryFromRelay tests).

- [ ] **Step 5: Commit**

```bash
git add src/chatlog.ts src/chatlog.test.ts
git commit -m "feat: add chatlog mapper (relay message -> chat entry)"
```

---

## Task 2: Chat panel markup + styles

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the bubble styles**

In `index.html`, find:

```html
      .tiny { font-size: 12px; color: var(--muted); margin-top: 10px; }
```

Insert immediately after it (still inside `<style>`):

```html
      .chat-label { font-weight: 700; margin: 16px 0 8px; }
      .chat {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 260px;
        overflow-y: auto;
        padding: 12px;
        border-radius: 14px;
        background: var(--field);
      }
      .chat-empty { color: var(--muted); font-size: 13px; text-align: center; padding: 16px 0; }
      .bubble {
        max-width: 85%;
        padding: 9px 12px;
        border-radius: 14px;
        font-size: 14px;
        line-height: 1.35;
        word-break: break-word;
      }
      .bubble.user { align-self: flex-end; background: var(--accent); color: var(--ink); border-bottom-right-radius: 5px; }
      .bubble.agent { align-self: flex-start; background: white; border: 1px solid var(--line); border-bottom-left-radius: 5px; }
      .bubble-label { font-size: 11px; font-weight: 800; color: var(--muted); letter-spacing: 0.04em; margin-bottom: 3px; }
      .bubble-text { white-space: pre-wrap; }
```

- [ ] **Step 2: Add the chat panel above the log**

In `index.html`, find:

```html
          <button id="voice" class="voice-btn" disabled>🎤 Voice</button>
          <div id="log" class="log">HermieHub companion ready.</div>
```

Replace with:

```html
          <button id="voice" class="voice-btn" disabled>🎤 Voice</button>
          <div class="chat-label">Conversation</div>
          <div id="chat" class="chat"><div class="chat-empty">No messages yet — tap to talk or type a command.</div></div>
          <div id="log" class="log">HermieHub companion ready.</div>
```

- [ ] **Step 3: Verify it renders (build)**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run build`
Expected: vite build succeeds (the `#chat` element is now in `dist/index.html`).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add conversation panel markup + bubble styles"
```

---

## Task 3: Render bubbles in `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Import the mapper**

Find:

```ts
import { reconnectDelayMs } from './reconnect'
```

Replace with:

```ts
import { reconnectDelayMs } from './reconnect'
import { chatEntryFromRelay, type ChatEntry } from './chatlog'
```

- [ ] **Step 2: Add the chat element reference**

Find:

```ts
const lensMirror = $<HTMLDivElement>('lensMirror')
```

Replace with:

```ts
const lensMirror = $<HTMLDivElement>('lensMirror')
const chatEl = $<HTMLDivElement>('chat')
```

- [ ] **Step 3: Add the bubble renderer**

Find:

```ts
function appendLog(line: string) {
```

Insert immediately before it:

```ts
// Render a chat entry as a bubble in the conversation panel and scroll to it.
function appendChat(entry: ChatEntry) {
  const empty = chatEl.querySelector('.chat-empty')
  if (empty) empty.remove()
  const bubble = document.createElement('div')
  bubble.className = `bubble ${entry.role}`
  if (entry.role === 'agent' && entry.label) {
    const lbl = document.createElement('div')
    lbl.className = 'bubble-label'
    lbl.textContent = entry.label
    bubble.appendChild(lbl)
  }
  const body = document.createElement('div')
  body.className = 'bubble-text'
  body.textContent = entry.text
  bubble.appendChild(body)
  chatEl.appendChild(bubble)
  chatEl.scrollTop = chatEl.scrollHeight
}

```

- [ ] **Step 4: Append agent/voice turns from relay messages**

Find:

```ts
function handleRelayMessage(msg: RelayMessage) {
  const line = msg.text || msg.hud || msg.message || msg.error || JSON.stringify(msg)
  appendLog(`${msg.type || 'relay'}: ${line}`)
```

Replace with:

```ts
function handleRelayMessage(msg: RelayMessage) {
  const line = msg.text || msg.hud || msg.message || msg.error || JSON.stringify(msg)
  appendLog(`${msg.type || 'relay'}: ${line}`)

  const chatEntry = chatEntryFromRelay(msg)
  if (chatEntry) appendChat(chatEntry)
```

- [ ] **Step 5: Add a typed-send handler that also adds a user bubble**

Find:

```ts
sendButton.addEventListener('click', () =>
  sendSocket({ type: 'prompt', agent: agentInput.value, prompt: promptInput.value }),
)
```

Replace with:

```ts
function sendTypedPrompt() {
  const text = promptInput.value.trim()
  if (!text) return
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendLog('Not connected to relay.')
    return
  }
  sendSocket({ type: 'prompt', agent: agentInput.value, prompt: text })
  appendChat({ role: 'user', text })
}
sendButton.addEventListener('click', sendTypedPrompt)
```

- [ ] **Step 6: Type-check, build, and run the full test suite**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run build && npm test`
Expected: `tsc` clean (strict, noUnusedLocals), vite build succeeds, all tests pass (endpointer + reconnect + chatlog).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "feat: render conversation bubbles from relay + typed sends"
```

---

## Task 4: Repackage for device test

**Files:**
- Modify: `out.ehpk` (regenerated)

- [ ] **Step 1: Repack**

Run: `cd ~/wearable-tech-lab/hermiehub && npm run pack`
Expected: `Successfully packed out.ehpk (... bytes)`.

- [ ] **Step 2: On-device verification (manual)**

1. Reload the app (dev tunnel) or reinstall `out.ehpk`; connect the relay.
2. Tap-to-talk a turn → confirm a right-aligned user bubble (your transcript) then a left-aligned **Bernie** bubble appear in the Conversation panel.
3. Type a command + Send → confirm a user bubble + agent bubble.
4. Scroll the panel up to read earlier turns.
5. Trigger an error (e.g. disconnect mid-send) → confirm it appears in the debug log, **not** the chat thread.

- [ ] **Step 3: Commit**

```bash
git add out.ehpk
git commit -m "chore: repack ehpk with conversation panel"
```

---

## Self-Review

**Spec coverage:**
- Session-only in-memory thread → no persistence anywhere (Task 3 renders directly to DOM, reset on reload). ✓
- Chat panel above the debug log → Task 2 markup order (chat then `#log`). ✓
- Bare conversation (user + agent only) → `chatEntryFromRelay` returns null for status/errors (Task 1); typed sends add user bubbles (Task 3 Step 5). ✓
- Labels Bernie/Codex → `agentLabel` (Task 1). ✓
- Errors stay in log → mapper returns null for `ok:false`; log unchanged. ✓
- Typed bubble only when sent while connected → Task 3 Step 5 guards on socket open. ✓
- Client-only, no relay/deps → only `src/` + `index.html`. ✓
- Empty-state placeholder → Task 2 markup + Task 3 removal on first bubble. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `ChatEntry`/`ChatRole`/`RelayLike`, `chatEntryFromRelay`, `agentLabel`, `appendChat` used identically across tasks. `appendChat(entry: ChatEntry)` matches the exported type; `RelayMessage` (main.ts) is structurally compatible with `RelayLike` (shares `type`/`text`/`ok`/`source`).
