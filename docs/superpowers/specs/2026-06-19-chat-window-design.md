# Companion Chat Window — Design Spec

**Date:** 2026-06-19
**Project:** HermieHub (`~/wearable-tech-lab/hermiehub/`)
**Status:** Approved design, pre-implementation

## Problem

The G2 lens shows only the latest agent line, and the companion app shows a
timestamped debug log — neither is a readable conversation. There's no way to
scroll back and read the back-and-forth with the agent. This adds a proper
chat thread to the phone companion UI.

## Locked decisions

- **Session-only.** The thread lives in memory and clears on reload/restart.
  Nothing is persisted (no localStorage).
- **Chat panel + keep the debug log.** A new scrollable "Conversation" panel
  sits *above* the existing `#log` panel, which stays for troubleshooting.
- **Bare conversation.** Only user turns and agent replies appear as bubbles.
  Status (transcribing, "cooking") and errors stay in the debug log, not the thread.

## Architecture

**Client-only.** No relay or STT changes. The companion builds the thread from
messages it already handles. The conversation is rendered directly to the DOM as
bubbles are added — no in-memory array is needed for a session-only thread.

Files:
- **Create** `src/chatlog.ts` — pure mapper from a relay message to a chat entry (testable, no DOM).
- **Create** `src/chatlog.test.ts` — vitest unit tests.
- **Modify** `src/main.ts` — render bubbles into the chat panel from the mapper + typed sends.
- **Modify** `index.html` — the scrollable "Conversation" panel + bubble styles.

### Pure unit: `chatEntryFromRelay`

```
type ChatRole = 'user' | 'agent'
interface ChatEntry { role: ChatRole; label?: string; text: string }

chatEntryFromRelay(msg: RelayMessage): ChatEntry | null
```

Rules:
- `msg.type === 'transcript'` with non-empty `text` → `{ role: 'user', text }`
- `msg.type === 'agent_result'` with `msg.ok === true` and non-empty `text`
  → `{ role: 'agent', label: agentLabel(msg.source), text }`
- anything else (status, `agent_result` with `ok === false`, errors, unknown) → `null`

`agentLabel(source)`: `'hermes' → 'Bernie'`, `'codex' → 'Codex'`, `'demo' → 'Demo'`,
otherwise the uppercased source or `'Agent'`. Lives in `chatlog.ts`, also pure.

### Data flow

```
typed Send (non-empty, relay connected) ──▶ render user bubble (prompt text)
relay 'transcript'      ─chatEntryFromRelay─▶ user bubble (voice transcript)
relay 'agent_result' ok ─chatEntryFromRelay─▶ agent bubble (Bernie/Codex label)
relay errors / status   ─chatEntryFromRelay─▶ null  → stays in #log only
```

The typed-Send bubble is added only when the prompt is non-empty **and** the relay
is connected (i.e. the message actually went out) — not when `sendSocket` rejects it
as disconnected. No duplication: the relay does not echo typed prompts as `transcript`
(transcript is voice-only), so the typed Send handler adds the user bubble directly
while voice turns come through the mapper.

### UI

- A scrollable `#chat` container inside the companion card, **above** `#log`, with a
  small "Conversation" label.
- **User** bubbles: right-aligned, accent background.
- **Agent** bubbles: left-aligned, light surface, with a small source label
  (Bernie / Codex) above the text.
- New messages **auto-scroll to the bottom**; the user can scroll up to read back.
- Empty state: a muted placeholder ("No messages yet — tap to talk or type a command.")
  shown until the first bubble is added.
- Capped height (e.g. ~240px) with `overflow-y: auto`; matches existing companion styling.

## Error handling

- Empty/whitespace text → no bubble.
- Errors and STT failures → not in the thread (the mapper returns `null`); they remain
  visible in `#log`, consistent with the "bare conversation" decision.

## Testing

- **Unit (`chatlog.test.ts`):** `transcript` → user entry; `agent_result` ok → agent
  entry with the correct label (`hermes`→Bernie, `codex`→Codex); `agent_result` with
  `ok: false` → null; unknown/status types → null; empty text → null.
- **Build:** `tsc` strict + vite.
- **On-device:** speak and type a few turns; confirm bubbles appear correctly labeled,
  the thread scrolls back, and errors stay in the log (not the thread).

## Scope / non-goals

- No persistence across reloads (session-only).
- No relay/STT changes; no new dependencies.
- No typing indicator, no message editing, no clear button (reload clears it).
- The debug log is unchanged and stays below the chat.
