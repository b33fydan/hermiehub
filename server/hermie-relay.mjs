import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'

// ---- Speech-to-text (local) ----
const STT_LANG = process.env.STT_LANG || 'en'
// Sample rate of the raw PCM the glasses stream in (Even G-series mic is 16 kHz
// 16-bit mono). If transcripts come back garbled, try 8000 / 24000 / 48000.
const STT_INPUT_RATE = Number(process.env.STT_INPUT_RATE || 16_000)
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg'
const WHISPER_MODEL =
  process.env.WHISPER_MODEL || path.join(os.homedir(), '.cache', 'whisper.cpp', 'ggml-base.en.bin')
const WHISPER_OPENAI_MODEL = process.env.WHISPER_OPENAI_MODEL || 'base.en'
const MAX_AUDIO_BYTES = Number(process.env.HERMIE_MAX_AUDIO_BYTES || 12_000_000) // ~6 min @ 16k/16-bit mono
const STT_TIMEOUT_MS = Number(process.env.HERMIE_STT_TIMEOUT_MS || 120_000)

const PORT = Number(process.env.HERMIE_RELAY_PORT || 8787)
const PROJECT_ROOT = process.cwd()
const TOKEN_PATH = process.env.HERMIE_RELAY_TOKEN_FILE || path.join(PROJECT_ROOT, '.relay-token')
const RELAY_TOKEN = process.env.HERMIE_RELAY_TOKEN || fs.readFileSync(TOKEN_PATH, 'utf8').trim()
const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const HERMES_BIN = process.env.HERMES_BIN || 'hermes'
const USER_NAME = process.env.HERMIE_USER_NAME || 'the user'
const AGENT_TIMEOUT_MS = Number(process.env.HERMIE_AGENT_TIMEOUT_MS || process.env.CODEX_TIMEOUT_MS || 45_000)
const MAX_PROMPT_CHARS = 1400
const MAX_REPLY_CHARS = 1400

const clients = new Set()
let lastSeq = 0

function nowIso() {
  return new Date().toISOString()
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ ts: nowIso(), ...payload }))
  }
}

function compactForHud(text, max = MAX_REPLY_CHARS) {
  return String(text || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function findOnPath(name) {
  if (!name) return null
  if (name.includes('/')) return fs.existsSync(name) ? name : null
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, name)
    try { fs.accessSync(full, fs.constants.X_OK); return full } catch { /* keep looking */ }
  }
  return null
}

// Pick a local STT engine. whisper.cpp (`whisper-cli`) is preferred for speed;
// falls back to openai-whisper (the `whisper` python CLI). Both are fully local.
function detectStt() {
  if (process.env.WHISPER_BIN) {
    const bin = findOnPath(process.env.WHISPER_BIN) || process.env.WHISPER_BIN
    const kind = /whisper-cli|whisper-cpp|main/.test(path.basename(bin)) ? 'cpp' : 'openai'
    return { bin, kind }
  }
  const cppBin = findOnPath('whisper-cli') || findOnPath('whisper-cpp')
  if (cppBin) return { bin: cppBin, kind: 'cpp' }
  const oaBin = findOnPath('whisper')
  if (oaBin) return { bin: oaBin, kind: 'openai' }
  return null
}

const STT = detectStt()
const HAS_FFMPEG = !!findOnPath(FFMPEG_BIN)

function runCapture(command, args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ code: 'timeout', stdout, stderr }) }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('error', err => done({ code: 'spawn_error', stdout, stderr: String(err.message) }))
    child.on('close', code => done({ code, stdout, stderr }))
    if (input) child.stdin.end(input); else child.stdin.end()
  })
}

// Fallback when ffmpeg is unavailable: wrap raw 16-bit mono PCM in a WAV header.
function writeWavFile(filePath, pcm, sampleRate) {
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]))
}

// Raw PCM (from the glasses) -> text, fully on this machine.
async function transcribe(pcm, inputRate) {
  if (!STT) {
    return { ok: false, error: 'No local STT engine found. Install whisper-cpp (brew install whisper-cpp) or openai-whisper.' }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermie-stt-'))
  const wavPath = path.join(tmpDir, 'clip.wav')
  try {
    // Normalize to 16 kHz mono 16-bit WAV (what whisper.cpp needs; openai-whisper accepts it too).
    if (HAS_FFMPEG) {
      const ff = await runCapture(FFMPEG_BIN, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(inputRate), '-ac', '1', '-i', 'pipe:0',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath,
      ], { input: pcm, timeoutMs: 30_000 })
      if (!fs.existsSync(wavPath)) {
        return { ok: false, error: `ffmpeg failed: ${compactForHud(ff.stderr, 300)}` }
      }
    } else {
      writeWavFile(wavPath, pcm, inputRate)
    }

    let text = ''
    if (STT.kind === 'cpp') {
      if (!fs.existsSync(WHISPER_MODEL)) {
        return { ok: false, error: `Whisper model missing at ${WHISPER_MODEL}.` }
      }
      const outPrefix = path.join(tmpDir, 'out')
      const res = await runCapture(STT.bin, [
        '-m', WHISPER_MODEL, '-f', wavPath, '-l', STT_LANG, '-nt', '-np', '-otxt', '-of', outPrefix,
      ], { timeoutMs: STT_TIMEOUT_MS })
      const txtPath = `${outPrefix}.txt`
      if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8')
      else if (res.code === 0) text = res.stdout
      else return { ok: false, error: `whisper-cli failed: ${compactForHud(res.stderr || res.stdout, 300)}` }
    } else {
      const res = await runCapture(STT.bin, [
        wavPath, '--model', WHISPER_OPENAI_MODEL, '--language', STT_LANG, '--task', 'transcribe',
        '--output_format', 'txt', '--output_dir', tmpDir, '--fp16', 'False', '--verbose', 'False',
      ], { timeoutMs: STT_TIMEOUT_MS })
      const txtPath = path.join(tmpDir, 'clip.txt')
      if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8')
      else if (res.code === 0) text = res.stdout
      else return { ok: false, error: `whisper failed: ${compactForHud(res.stderr || res.stdout, 300)}` }
    }

    text = text.replace(/\[[0-9:.\s>-]+\]/g, '').replace(/\s+/g, ' ').trim()
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

function authFromRequest(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const queryToken = url.searchParams.get('token')
  const authHeader = req.headers.authorization || ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  return queryToken || bearerToken
}

function runAgent(agent, prompt) {
  return new Promise((resolve) => {
    const safePrompt = String(prompt || '').slice(0, MAX_PROMPT_CHARS)
    const isHermes = agent === 'hermes'
    const agentName = isHermes ? 'Hermes/Bernie' : 'Codex'
    const instruction = [
      `You are ${agentName}, replying to ${USER_NAME} through Even Realities G2 smart glasses via HermieHub.`,
      'Keep the answer useful, punchy, and HUD-friendly.',
      'No markdown tables. Max 8 short lines unless absolutely necessary.',
      'If the user asks for longer work, acknowledge it and say the full result should go to Telegram/desktop.',
      '',
      `User command: ${safePrompt}`,
    ].join('\n')

    const command = isHermes ? HERMES_BIN : CODEX_BIN
    const args = isHermes
      ? ['-t', 'terminal,web', '-z', instruction]
      : ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', PROJECT_ROOT, instruction]

    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({
        ok: false,
        code: 'timeout',
        text: `${agentName} timed out. HermieHub relay is alive, but the agent took too long for HUD mode.`,
        stderr: compactForHud(stderr, 500),
      })
    }, AGENT_TIMEOUT_MS)

    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })

    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: 'spawn_error', text: `Could not launch ${agentName}: ${error.message}`, stderr: '' })
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const text = compactForHud(stdout || stderr || `${agentName} returned no output.`)
      resolve({ ok: code === 0, code, text, stderr: compactForHud(stderr, 500) })
    })
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, name: 'HermieHub Relay', clients: clients.size, time: nowIso() }))
    return
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('HermieHub Relay online. Use WebSocket /relay?token=...')
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
})

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

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/relay') {
    socket.destroy()
    return
  }

  if (authFromRequest(req) !== RELAY_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (ws, req) => {
  clients.add(ws)
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  const remote = req.socket.remoteAddress
  send(ws, {
    type: 'hello',
    seq: ++lastSeq,
    status: 'connected',
    message: 'HermieHub relay connected. Hermes/Bernie + Codex bridges armed.',
    hud: 'HERMIEHUB ONLINE\nRelay connected.\nModes: Hermes/Bernie or Codex.',
  })

  ws.on('message', async raw => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      send(ws, { type: 'error', seq: ++lastSeq, message: 'Invalid JSON message.' })
      return
    }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong', seq: ++lastSeq, message: 'pong' })
      return
    }

    if (msg.type === 'demo') {
      send(ws, {
        type: 'agent_result',
        seq: ++lastSeq,
        ok: true,
        source: 'demo',
        text: 'HermieHub demo packet received.\nRelay token accepted.\nG2 HUD path works.\nNext: voice → Hermes/Bernie → glasses.',
      })
      return
    }

    if (msg.type === 'prompt') {
      const prompt = String(msg.prompt || '').trim()
      if (!prompt) {
        send(ws, { type: 'error', seq: ++lastSeq, message: 'Prompt was empty.' })
        return
      }

      const agent = msg.agent === 'codex' ? 'codex' : 'hermes'
      const agentLabel = agent === 'hermes' ? 'Hermes/Bernie' : 'Codex'
      send(ws, {
        type: 'agent_started',
        seq: ++lastSeq,
        message: `${agentLabel} is cooking. Hold the lens goblins at bay.`,
        agent,
        prompt: prompt.slice(0, 160),
      })

      const result = await runAgent(agent, prompt)
      send(ws, {
        type: 'agent_result',
        seq: ++lastSeq,
        ok: result.ok,
        source: agent,
        text: result.text,
        error: result.ok ? undefined : result.stderr || result.code,
      })
      return
    }

    if (msg.type === 'voice') {
      const b64 = typeof msg.pcm === 'string' ? msg.pcm : typeof msg.audio === 'string' ? msg.audio : ''
      if (!b64) {
        send(ws, { type: 'error', seq: ++lastSeq, message: 'Voice message had no audio.' })
        return
      }
      const pcm = Buffer.from(b64, 'base64')
      if (!pcm.length) {
        send(ws, { type: 'error', seq: ++lastSeq, message: 'Voice audio was empty.' })
        return
      }
      if (pcm.length > MAX_AUDIO_BYTES) {
        send(ws, { type: 'error', seq: ++lastSeq, message: 'Voice clip too long.' })
        return
      }

      const inputRate = Number(msg.rate) > 0 ? Number(msg.rate) : STT_INPUT_RATE
      const seconds = (pcm.length / 2 / inputRate).toFixed(1)
      send(ws, {
        type: 'transcribing',
        seq: ++lastSeq,
        message: `Heard ${seconds}s of audio. Transcribing locally…`,
        hud: `GOT ${seconds}s AUDIO\nTranscribing on the\nMac mini…`,
      })

      const stt = await transcribe(pcm, inputRate)
      if (!stt.ok) {
        send(ws, { type: 'agent_result', seq: ++lastSeq, ok: false, source: 'stt', error: stt.error, text: `Transcription failed.\n${stt.error}` })
        return
      }
      if (!stt.text) {
        send(ws, { type: 'agent_result', seq: ++lastSeq, ok: false, source: 'stt', text: "Didn't catch that. Try again, closer to the mic." })
        return
      }

      send(ws, { type: 'transcript', seq: ++lastSeq, text: stt.text, hud: `YOU SAID\n${stt.text}` })

      const agent = msg.agent === 'codex' ? 'codex' : 'hermes'
      const agentLabel = agent === 'hermes' ? 'Hermes/Bernie' : 'Codex'
      send(ws, {
        type: 'agent_started',
        seq: ++lastSeq,
        message: `${agentLabel} is cooking. Hold the lens goblins at bay.`,
        agent,
        prompt: stt.text.slice(0, 160),
      })

      const result = await runAgent(agent, stt.text)
      send(ws, {
        type: 'agent_result',
        seq: ++lastSeq,
        ok: result.ok,
        source: agent,
        text: result.text,
        error: result.ok ? undefined : result.stderr || result.code,
      })
      return
    }

    send(ws, { type: 'error', seq: ++lastSeq, message: `Unknown message type: ${msg.type}` })
  })

  ws.on('close', () => clients.delete(ws))
  ws.on('error', () => clients.delete(ws))

  console.log(`[${nowIso()}] client connected from ${remote}; clients=${clients.size}`)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HermieHub Relay listening on http://localhost:${PORT}`)
  console.log(`WebSocket path: ws://localhost:${PORT}/relay?token=<token>`)
  console.log(`Token file: ${TOKEN_PATH}`)
  console.log(`Host: ${os.hostname()}`)
  if (STT) {
    console.log(`STT: ${STT.kind === 'cpp' ? 'whisper.cpp' : 'openai-whisper'} (${STT.bin})`)
    if (STT.kind === 'cpp') console.log(`STT model: ${WHISPER_MODEL}${fs.existsSync(WHISPER_MODEL) ? '' : '  [MISSING]'}`)
    console.log(`ffmpeg: ${HAS_FFMPEG ? findOnPath(FFMPEG_BIN) : 'NOT FOUND (raw PCM must already be 16k mono)'}`)
  } else {
    console.log('STT: none detected — voice will fail until whisper-cpp or openai-whisper is installed.')
  }
})
