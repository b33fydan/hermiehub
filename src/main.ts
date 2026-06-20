import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { createEndpointer, type EndpointerResult } from './endpointer'
import { reconnectDelayMs } from './reconnect'
import { chatEntryFromRelay, type ChatEntry } from './chatlog'
import { isConnectionStale } from './heartbeat'

type RelayState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'
type VoiceState = 'idle' | 'listening' | 'processing'
type RelayMessage = {
  type?: string
  status?: string
  message?: string
  text?: string
  hud?: string
  ok?: boolean
  source?: string
  error?: string
}

// Sample rate of the PCM the Even glasses stream over the bridge. Even G-series
// mics are 16 kHz / 16-bit / mono. If transcripts come back garbled, try 8000,
// 24000, or 48000 here (and the relay will resample either way).
const GLASSES_SAMPLE_RATE = 16_000

// Auto-stop tuning. Adjust these using the rms values logged during listening.
const SILENCE_RMS_THRESHOLD = 0.015 // normalized loudness below which a window is "silent"
const SILENCE_HANGOVER_MS = 1500 // silence after speech that ends the utterance
const MIN_SPEECH_MS = 300 // speech required before auto-stop can arm
const MAX_UTTERANCE_MS = 15_000 // hard cutoff — always sends, never hangs
const LEAD_GRACE_MS = 4000 // if no speech by now, cancel quietly

const MAX_RECONNECT_ATTEMPTS = 10 // give up auto-reconnect after this many tries
const CLIENT_HEARTBEAT_MS = 25_000 // app-level ping cadence (under the tunnel's ~100s idle cap)
const RELAY_SILENCE_MS = 40_000 // no message for this long → treat the socket as dead
const PROCESSING_TIMEOUT_MS = 150_000 // give up waiting for a reply after this (> max STT+agent time)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const addressInput = $<HTMLInputElement>('address')
const tokenInput = $<HTMLInputElement>('token')
const promptInput = $<HTMLTextAreaElement>('prompt')
const agentInput = $<HTMLSelectElement>('agent')
const connectButton = $<HTMLButtonElement>('connect')
const sendButton = $<HTMLButtonElement>('send')
const demoButton = $<HTMLButtonElement>('demo')
const voiceButton = $<HTMLButtonElement>('voice')
const logEl = $<HTMLDivElement>('log')
const statusEl = $<HTMLSpanElement>('status')
const dotEl = $<HTMLSpanElement>('dot')
const lensMirror = $<HTMLDivElement>('lensMirror')
const chatEl = $<HTMLDivElement>('chat')

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>> | null = null
let bridgeReady = false
let socket: WebSocket | null = null
let relayState: RelayState = 'disconnected'
let userClosed = false // true when the user (not a drop) ended the connection
let reconnectAttempts = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let lastWsUrl: string | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let lastRelayMessageAt = 0
let processingTimer: ReturnType<typeof setTimeout> | null = null
let voiceState: VoiceState = 'idle'
let lastHud = 'HERMIEHUB\nEnter relay URL + token.\nConnect to arm the wearable agent bridge.'
let cardIndex = 0

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

function voiceAvailable() {
  return bridgeReady && relayState === 'connected'
}

const cards = [
  () => lastHud,
  () =>
    'HERMIEHUB // STATUS\n' +
    `Relay: ${relayState}\n` +
    `Agent: ${agentInput?.value || 'hermes'}\n` +
    `Voice: ${voiceAvailable() ? 'glasses mic ready' : bridgeReady ? 'connect relay' : 'waiting for bridge'}\n` +
    'Tap = talk. Swipe = cards. Double-tap exits.',
  () =>
    'HOW TO USE\n' +
    '1. Connect relay\n' +
    '2. Tap temple, just talk\n' +
    '3. Bernie replies on lens\n' +
    'Swipe to flip cards',
]

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

function appendLog(line: string) {
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  logEl.textContent = `${stamp} ${line}\n${logEl.textContent || ''}`.slice(0, 1400)
}

// ---- Audio byte helpers ----
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// The host may deliver PCM as a Uint8Array, a number[], or a base64 string.
function toBytes(audioPcm: unknown): Uint8Array | null {
  if (audioPcm instanceof Uint8Array) return audioPcm
  if (Array.isArray(audioPcm)) return Uint8Array.from(audioPcm as number[])
  if (typeof audioPcm === 'string') return base64ToBytes(audioPcm)
  if (audioPcm && typeof audioPcm === 'object' && 'length' in (audioPcm as ArrayLike<number>)) {
    try { return Uint8Array.from(audioPcm as ArrayLike<number>) } catch { return null }
  }
  return null
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}

function setVoiceState(next: VoiceState) {
  voiceState = next
  if (next === 'processing') armProcessingWatchdog()
  else clearProcessingWatchdog()
  if (next === 'listening') {
    voiceButton.textContent = '🔴 Listening… (tap to send)'
    voiceButton.style.background = 'var(--bad)'
    voiceButton.disabled = false
    lastHud = '🎤 LISTENING\nSpeak now — I send\nwhen you go quiet.'
    rebuildHud().catch(console.error)
  } else if (next === 'processing') {
    voiceButton.textContent = '⏳ Sending…'
    voiceButton.style.background = 'var(--accent)'
    voiceButton.disabled = true
    lastHud = 'AGENT COOKING\nVoice received.\nProcessing your command…'
    rebuildHud().catch(console.error)
  } else {
    voiceButton.textContent = '🎤 Voice'
    voiceButton.style.background = ''
    voiceButton.disabled = !voiceAvailable()
  }
}

function setRelayState(next: RelayState) {
  relayState = next
  statusEl.textContent = next === 'reconnecting' ? 'Reconnecting…' : next[0].toUpperCase() + next.slice(1)
  dotEl.classList.toggle('connected', next === 'connected')
  connectButton.textContent =
    next === 'connected'
      ? 'Disconnect'
      : next === 'connecting'
        ? 'Connecting…'
        : next === 'reconnecting'
          ? 'Cancel'
          : 'Connect'
  if (voiceState === 'idle') voiceButton.disabled = !voiceAvailable()
  rebuildHud().catch(console.error)
}

function normalizeWsUrl(rawAddress: string, token: string) {
  const trimmed = rawAddress.trim()
  if (!trimmed) throw new Error('Address is empty')
  const url = new URL(trimmed.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'))
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new Error('Address must start with ws:// or wss://')
  if (!url.pathname || url.pathname === '/') url.pathname = '/relay'
  url.searchParams.set('token', token)
  return url.toString()
}

function createText(content: string) {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 8,
    containerID: 1,
    containerName: 'hermiehub-main',
    content,
    isEventCapture: 1,
  })
}

function currentHud() {
  const body = cards[cardIndex]()
  return [`HERMIEHUB ${cardIndex + 1}/${cards.length}`, '------------------------------', body].join('\n')
}

// Mirror the exact glasses HUD string into the companion "lens preview" so the
// phone (or desktop) can be screen-recorded. Updates on every HUD change.
function renderLensMirror() {
  if (lensMirror) lensMirror.textContent = currentHud()
}

async function rebuildHud() {
  renderLensMirror()
  if (!bridge) return
  await bridge.rebuildPageContainer(
    new RebuildPageContainer({ containerTotalNum: 1, textObject: [createText(currentHud())] }),
  )
}

function sendSocket(payload: Record<string, unknown>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendLog('Not connected to relay.')
    return
  }
  socket.send(JSON.stringify(payload))
}

function handleRelayMessage(msg: RelayMessage) {
  const line = msg.text || msg.hud || msg.message || msg.error || JSON.stringify(msg)
  appendLog(`${msg.type || 'relay'}: ${line}`)

  const chatEntry = chatEntryFromRelay(msg)
  if (chatEntry) appendChat(chatEntry)

  // Any message while processing is proof of life — push the no-response timeout out.
  if (voiceState === 'processing') armProcessingWatchdog()

  if (msg.type === 'transcript' && msg.text) {
    promptInput.value = msg.text
    lastHud = `YOU SAID\n${msg.text}`
  } else if (msg.hud) {
    lastHud = msg.hud
  } else if (msg.type === 'agent_started') {
    lastHud = 'AGENT COOKING\n' + (msg.message || 'Agent started.')
  } else if (msg.type === 'agent_result') {
    const label = msg.source === 'hermes' ? 'BERNIE' : String(msg.source || 'AGENT').toUpperCase()
    lastHud = `${msg.ok ? `${label} SAYS` : `${label} ERROR`}\n${msg.text || msg.error || 'No response.'}`
    setVoiceState('idle')
  } else if (msg.message) {
    lastHud = `HERMIEHUB\n${msg.message}`
  }

  cardIndex = 0
  rebuildHud().catch(console.error)
}

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

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
}

function scheduleReconnect() {
  if (!lastWsUrl || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (lastWsUrl) appendLog(`Gave up reconnecting after ${reconnectAttempts} tries. Tap Connect to retry.`)
    reconnectAttempts = 0
    setRelayState('disconnected')
    return
  }
  reconnectAttempts += 1
  const delay = reconnectDelayMs(reconnectAttempts)
  setRelayState('reconnecting')
  appendLog(`Relay dropped. Reconnecting in ${Math.round(delay / 1000)}s (try ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (lastWsUrl && !userClosed) openSocket(lastWsUrl)
  }, delay)
}

function openSocket(wsUrl: string) {
  lastWsUrl = wsUrl
  if (relayState !== 'reconnecting') setRelayState('connecting')

  socket = new WebSocket(wsUrl)
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
  socket.addEventListener('error', () => { appendLog('Relay socket error.') })
}

function connectRelay() {
  // Cancel an in-progress auto-reconnect.
  if (relayState === 'reconnecting') {
    userClosed = true
    clearReconnect()
    setRelayState('disconnected')
    appendLog('Reconnect cancelled.')
    return
  }
  // Disconnect if currently connected.
  if (socket && socket.readyState === WebSocket.OPEN) {
    userClosed = true
    clearReconnect()
    socket.close()
    return
  }

  const token = tokenInput.value.trim()
  if (!token) { appendLog('Token required.'); return }

  let wsUrl: string
  try {
    wsUrl = normalizeWsUrl(addressInput.value, token)
  } catch (error) {
    appendLog(error instanceof Error ? error.message : 'Invalid address')
    return
  }

  localStorage.setItem('hermiehub.address', addressInput.value.trim())
  localStorage.setItem('hermiehub.token', token)

  userClosed = false
  reconnectAttempts = 0
  appendLog(`Connecting to ${wsUrl.replace(token, '••••')}`)
  openSocket(wsUrl)
}

// Open the glasses mic via the Even bridge and start collecting PCM.
async function startListening() {
  if (!bridge) { appendLog('Bridge not ready.'); return }
  if (relayState !== 'connected') { appendLog('Connect to relay first.'); return }

  pcmChunks = []
  endpointer.reset()
  lastLevelLogMs = 0
  try {
    const ok = await bridge.audioControl(true)
    if (!ok) {
      appendLog('Glasses mic refused to open (audioControl returned false).')
      lastHud = 'MIC BLOCKED\nGlasses mic refused.\nCheck Even app mic permission\n+ that glasses are worn.'
      cardIndex = 0
      rebuildHud().catch(console.error)
      return
    }
    setVoiceState('listening')
    appendLog('Glasses mic open. Speak, then tap Voice to send.')
  } catch (error) {
    appendLog(`Could not open glasses mic: ${error instanceof Error ? error.message : String(error)}`)
    setVoiceState('idle')
  }
}

// Close the glasses mic, package the captured PCM, and send to the relay for STT.
async function stopListening() {
  try {
    await bridge?.audioControl(false)
  } catch (error) {
    appendLog(`audioControl(false) error: ${error instanceof Error ? error.message : String(error)}`)
  }

  const pcm = concatChunks(pcmChunks)
  pcmChunks = []

  if (!pcm.length) {
    appendLog('No audio captured. Is the glasses mic streaming?')
    setVoiceState('idle')
    return
  }

  const seconds = (pcm.length / 2 / GLASSES_SAMPLE_RATE).toFixed(1)
  appendLog(`Captured ${pcm.length} bytes (~${seconds}s). Sending for transcription…`)
  setVoiceState('processing')
  sendSocket({ type: 'voice', agent: agentInput.value, rate: GLASSES_SAMPLE_RATE, pcm: bytesToBase64(pcm) })
}

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
  if (!voiceAvailable() && voiceState === 'idle') {
    appendLog(bridgeReady ? 'Connect to relay first.' : 'Waiting for Even bridge…')
    return
  }
  if (voiceState === 'listening') {
    stopListening().catch(console.error)
  } else if (voiceState === 'idle') {
    startListening().catch(console.error)
  }
}

async function bootGlasses() {
  bridge = await waitForEvenAppBridge()
  bridgeReady = true
  if (voiceState === 'idle') voiceButton.disabled = !voiceAvailable()
  appendLog('Even bridge ready.')

  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [createText(currentHud())] }),
  )
  appendLog(result === 0 ? 'Glasses page created.' : `Glasses page create failed: ${result}`)

  const unsubscribe = bridge.onEvenHubEvent(event => {
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

    // Drive control from sysEvent (the system gesture stream). The text-container
    // touch (textEvent) is raw down/up noise, so we ignore it here.
    const sysEvt = event.sysEvent
    if (!sysEvt) return

    // NOTE: protobuf omits zero-valued fields on the wire, so CLICK_EVENT
    // (eventType 0) arrives with eventType ABSENT (undefined), not 0.
    const sysType = sysEvt.eventType

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      if (voiceState === 'listening') bridge?.audioControl(false).catch(console.error)
      userClosed = true
      clearReconnect()
      socket?.close()
      bridge?.shutDownPageContainer(1)
      return
    }

    if (sysType === OsEventTypeList.SCROLL_TOP_EVENT) {
      cardIndex = (cardIndex - 1 + cards.length) % cards.length
      rebuildHud().catch(console.error)
      return
    }

    if (sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
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
      if (voiceState === 'listening') bridge?.audioControl(false).catch(console.error)
      userClosed = true
      clearReconnect()
      socket?.close()
      unsubscribe()
      return
    }

    // Single tap = talk. CLICK_EVENT (0) is omitted on the wire, so a sysEvent
    // that matched none of the above (eventType absent, or an explicit 0) is a tap.
    if (sysType === undefined || sysType === OsEventTypeList.CLICK_EVENT) {
      toggleVoice()
      return
    }
  })
}

// Init
addressInput.value = localStorage.getItem('hermiehub.address') || ''
tokenInput.value = localStorage.getItem('hermiehub.token') || ''
agentInput.value = localStorage.getItem('hermiehub.agent') || 'hermes'
promptInput.value = 'Bernie, what should I build on Even G2 next?'
voiceButton.disabled = true // enabled once bridge + relay are ready

connectButton.addEventListener('click', connectRelay)
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
demoButton.addEventListener('click', () => sendSocket({ type: 'demo' }))
voiceButton.addEventListener('click', toggleVoice)
agentInput.addEventListener('change', () => {
  localStorage.setItem('hermiehub.agent', agentInput.value)
  rebuildHud().catch(console.error)
})

renderLensMirror() // paint the first HUD frame immediately

bootGlasses().catch(error => {
  appendLog(`Bridge boot failed: ${error instanceof Error ? error.message : String(error)}`)
  console.error(error)
})
