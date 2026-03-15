/**
 * dev.ts — Development server for CodeAgent
 *
 * Starts a lightweight HTTP server that:
 *   1. Serves a simple HTML chat UI at http://localhost:3210
 *   2. Exposes POST /api/chat (SSE) to stream agent responses
 *
 * Build & run:
 *   pnpm run dev
 *
 * Environment variables:
 *   PROVIDER    — LLM provider id  (default: "anthropic")
 *   MODEL       — LLM model id     (default: "claude-sonnet-4-20250514")
 *   API_KEY     — Provider API key  (required)
 *   PORT        — HTTP port         (default: 3210)
 */

import http from "http"
import path from "path"
import os from "os"
import fs from "fs"
import { execFile } from "child_process"
import { CodeAgent } from "@any-code/opencode"
import { SqlJsStorage } from "./src/storage-sqljs"
import { NodeFS } from "./src/vfs-node"
import { NodeSearchProvider } from "./src/search-node"

// ── Config ─────────────────────────────────────────────────────────────────

const PROVIDER = process.env.PROVIDER ?? "anthropic"
const MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514"
const API_KEY = process.env.API_KEY
const BASE_URL = process.env.BASE_URL
const PORT = parseInt(process.env.PORT ?? "3210", 10)
const PROJECT_DIR = path.resolve(process.argv[2] ?? process.cwd())

if (!API_KEY) {
  console.error("❌  Missing API_KEY environment variable")
  console.error("Usage: API_KEY=sk-xxx pnpm run dev")
  process.exit(1)
}

// ── Paths ──────────────────────────────────────────────────────────────────

function makePaths() {
  const dataPath = path.join(os.homedir(), ".any-code", "dev", "data")
  fs.mkdirSync(dataPath, { recursive: true })
  return dataPath
}

// ── HTML Page ──────────────────────────────────────────────────────────────

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeAgent Dev</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1e1e1e; --surface: #252526; --surface2: #2d2d2d; --border: #3e3e42;
    --text: #cccccc; --text-bright: #e0e0e0; --muted: #808080; --accent: #0078d4;
    --accent-soft: #264f78; --green: #4ec9b0; --green-bg: rgba(78,201,176,0.08);
    --red: #f44747; --red-bg: rgba(244,71,71,0.08); --yellow: #dcdcaa;
    --orange: #ce9178; --purple: #c586c0;
    --mono: 'Cascadia Code', 'Fira Code', 'SF Mono', Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  body { font-family: var(--sans); background: var(--bg); color: var(--text);
    height: 100vh; display: flex; flex-direction: column; font-size: 13px; }

  /* ── Header ── */
  header { padding: 8px 16px; border-bottom: 1px solid var(--border); display: flex;
    align-items: center; gap: 10px; background: var(--surface); min-height: 36px; }
  header h1 { font-size: 13px; font-weight: 600; color: var(--text-bright); }
  .badge { font-size: 11px; background: var(--accent); color: #fff; padding: 1px 8px;
    border-radius: 3px; font-weight: 500; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted);
    margin-left: auto; transition: background .3s; }
  .status-dot.busy { background: var(--accent); animation: pulse 1.5s infinite; }
  .status-dot.idle { background: var(--green); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* ── Messages area ── */
  #messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex;
    flex-direction: column; gap: 2px; }

  /* ── User message ── */
  .msg-user { padding: 8px 0; margin-top: 12px; }
  .msg-user-label { font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px; }
  .msg-user-text { color: var(--text-bright); line-height: 1.5; white-space: pre-wrap; word-break: break-word; }

  /* ── Assistant response container ── */
  .response { padding: 8px 0; border-left: 2px solid var(--border); padding-left: 14px; margin-left: 4px; }

  /* ── Thinking block ── */
  .thinking { margin: 6px 0; }
  .thinking summary { cursor: pointer; font-size: 12px; color: var(--purple); user-select: none;
    list-style: none; display: flex; align-items: center; gap: 6px; padding: 4px 0; }
  .thinking summary::before { content: '▸'; transition: transform .15s; display: inline-block; }
  .thinking[open] summary::before { transform: rotate(90deg); }
  .thinking summary .dur { font-size: 10px; background: var(--surface2); color: var(--muted);
    padding: 1px 6px; border-radius: 3px; margin-left: 4px; }
  .thinking-content { font-size: 12px; color: var(--muted); line-height: 1.5;
    padding: 6px 0 6px 20px; white-space: pre-wrap; word-break: break-word;
    max-height: 200px; overflow-y: auto; border-left: 1px solid var(--border); margin-left: 2px; }

  /* ── Text block ── */
  .text-block { color: var(--text-bright); line-height: 1.6; white-space: pre-wrap;
    word-break: break-word; padding: 2px 0; }

  /* ── Tool card ── */
  .tool-card { margin: 6px 0; padding: 6px 10px; background: var(--surface2); border-radius: 4px;
    border: 1px solid var(--border); font-family: var(--mono); font-size: 12px; display: flex;
    align-items: center; gap: 8px; }
  .tool-icon { width: 16px; text-align: center; flex-shrink: 0; }
  .tool-name { color: var(--yellow); font-weight: 500; }
  .tool-args { color: var(--muted); margin-left: 4px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; max-width: 300px; }
  .tool-status { margin-left: auto; font-size: 11px; color: var(--muted); flex-shrink: 0; }
  .tool-card.running { border-color: var(--accent-soft); }
  .tool-card.done { border-color: rgba(78,201,176,0.3); }
  .tool-card.error { border-color: rgba(244,71,71,0.3); background: var(--red-bg); }

  /* ── Message footer (token usage) ── */
  .msg-footer { margin: 8px 0; padding: 4px 0; font-size: 11px; color: var(--muted);
    border-top: 1px solid var(--border); display: flex; gap: 12px; }
  .msg-footer span { display: flex; align-items: center; gap: 3px; }

  /* ── Error banner ── */
  .error-banner { margin: 6px 0; padding: 6px 10px; background: var(--red-bg); border-radius: 4px;
    border: 1px solid rgba(244,71,71,0.3); color: var(--red); font-size: 12px; }

  /* ── Input bar ── */
  #input-bar { padding: 10px 16px; border-top: 1px solid var(--border); background: var(--surface);
    display: flex; gap: 8px; }
  #input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    padding: 8px 12px; color: var(--text-bright); font-size: 13px; outline: none; resize: none;
    font-family: var(--sans); min-height: 36px; max-height: 120px; }
  #input:focus { border-color: var(--accent); }
  #send { background: var(--accent); color: #fff; border: none; border-radius: 4px;
    padding: 8px 16px; font-weight: 600; font-size: 13px; cursor: pointer; transition: opacity .15s; }
  #send:hover { opacity: .85; }
  #send:disabled { opacity: .4; cursor: not-allowed; }
</style>
</head>
<body>
<header>
  <h1>🤖 CodeAgent</h1>
  <span class="badge">${PROVIDER} / ${MODEL}</span>
  <div class="status-dot idle" id="status-dot" title="idle"></div>
</header>
<div id="messages"></div>
<div id="input-bar">
  <textarea id="input" rows="1" placeholder="Send a message…"
    onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"></textarea>
  <button id="send" onclick="send()">Send</button>
</div>
<script>
const msgs = document.getElementById('messages')
const inp = document.getElementById('input')
const btn = document.getElementById('send')
const statusDot = document.getElementById('status-dot')
let sessionId = null
let busy = false

// ── DOM helpers ──
function scrollBottom() { msgs.scrollTop = msgs.scrollHeight }

function el(tag, cls, parent) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (parent) parent.appendChild(e)
  return e
}

// ── State for current response ──
let responseContainer = null
let currentTextEl = null
let currentThinkingDetails = null
let currentThinkingContent = null
let toolCards = {}

function startResponse() {
  responseContainer = el('div', 'response', msgs)
  currentTextEl = null
  currentThinkingDetails = null
  currentThinkingContent = null
  toolCards = {}
}

function ensureTextBlock() {
  if (!currentTextEl) {
    currentTextEl = el('div', 'text-block', responseContainer)
  }
  return currentTextEl
}

function endTextBlock() { currentTextEl = null }

// ── Send message ──
async function send() {
  const text = inp.value.trim()
  if (!text || busy) return
  inp.value = ''

  // User message
  const userDiv = el('div', 'msg-user', msgs)
  el('div', 'msg-user-label', userDiv).textContent = 'You'
  el('div', 'msg-user-text', userDiv).textContent = text

  busy = true; btn.disabled = true
  startResponse()

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          handleEvent(data)
        } catch(e) { /* skip malformed */ }
      }
    }
  } catch (e) {
    const errDiv = el('div', 'error-banner', responseContainer || msgs)
    errDiv.textContent = '⚠ ' + e.message
  }
  busy = false; btn.disabled = false; inp.focus()
}

// ── Event handler ──
function handleEvent(data) {
  if (data.sessionId) { sessionId = data.sessionId; return }
  if (!responseContainer) startResponse()

  switch (data.type) {
    case 'session.status': {
      const s = data.status || 'idle'
      statusDot.className = 'status-dot ' + s
      statusDot.title = s
      break
    }

    case 'message.start': {
      // New assistant message — could reset UI state here if needed
      break
    }

    case 'thinking.start': {
      endTextBlock()
      const details = el('details', 'thinking', responseContainer)
      const summary = el('summary', '', details)
      summary.innerHTML = '💭 Thinking <span class="dur">…</span>'
      currentThinkingContent = el('div', 'thinking-content', details)
      currentThinkingDetails = details
      scrollBottom()
      break
    }

    case 'thinking.delta': {
      if (currentThinkingContent) {
        currentThinkingContent.textContent += data.thinkingContent || ''
        scrollBottom()
      }
      break
    }

    case 'thinking.end': {
      if (currentThinkingDetails) {
        const dur = data.thinkingDuration
        const label = dur >= 1000 ? (dur / 1000).toFixed(1) + 's' : dur + 'ms'
        const summary = currentThinkingDetails.querySelector('summary')
        if (summary) summary.innerHTML = '💭 Thinking <span class="dur">' + label + '</span>'
        currentThinkingDetails = null
        currentThinkingContent = null
      }
      break
    }

    case 'text.delta': {
      const block = ensureTextBlock()
      block.textContent += data.content || ''
      scrollBottom()
      break
    }

    case 'tool.start': {
      endTextBlock()
      const card = el('div', 'tool-card running', responseContainer)
      const argText = toolArgSummary(data.toolArgs)
      card.innerHTML =
        '<span class="tool-icon">⏳</span>' +
        '<span class="tool-name">' + esc(data.toolName || '') + '</span>' +
        '<span class="tool-args" title="' + argText + '">' + argText + '</span>' +
        '<span class="tool-status">running…</span>'
      if (data.toolCallId) toolCards[data.toolCallId] = card
      scrollBottom()
      break
    }

    case 'tool.done': {
      const card = data.toolCallId && toolCards[data.toolCallId]
      if (card) {
        card.className = 'tool-card done'
        const dur = data.toolDuration
        const label = dur != null ? (dur >= 1000 ? (dur/1000).toFixed(1)+'s' : dur+'ms') : ''
        const argText = esc(data.toolTitle || '') || toolArgSummary(data.toolArgs)
        card.innerHTML =
          '<span class="tool-icon">✓</span>' +
          '<span class="tool-name">' + esc(data.toolName || '') + '</span>' +
          '<span class="tool-args" title="' + argText + '">' + argText + '</span>' +
          '<span class="tool-status">' + label + '</span>'
      }
      break
    }

    case 'tool.error': {
      const card = data.toolCallId && toolCards[data.toolCallId]
      if (card) {
        card.className = 'tool-card error'
        const dur = data.toolDuration
        const label = dur != null ? (dur >= 1000 ? (dur/1000).toFixed(1)+'s' : dur+'ms') : ''
        const errText = esc(data.error || 'error')
        card.innerHTML =
          '<span class="tool-icon">✗</span>' +
          '<span class="tool-name">' + esc(data.toolName || '') + '</span>' +
          '<span class="tool-args" title="' + errText + '">' + errText + '</span>' +
          '<span class="tool-status">' + label + '</span>'
      } else {
        const errDiv = el('div', 'error-banner', responseContainer)
        errDiv.textContent = '⚠ Tool error: ' + (data.error || 'unknown')
      }
      break
    }

    case 'message.done': {
      endTextBlock()
      if (data.usage) {
        const footer = el('div', 'msg-footer', responseContainer)
        const u = data.usage
        const fmtK = (n) => n >= 1000 ? (n/1000).toFixed(1)+'k' : String(n)
        footer.innerHTML =
          '<span>↓ ' + fmtK(u.inputTokens) + '</span>' +
          '<span>↑ ' + fmtK(u.outputTokens) + '</span>' +
          (u.reasoningTokens ? '<span>🧠 ' + fmtK(u.reasoningTokens) + '</span>' : '') +
          '<span>$' + u.cost.toFixed(4) + '</span>'
      }
      scrollBottom()
      break
    }

    case 'error': {
      const errDiv = el('div', 'error-banner', responseContainer || msgs)
      errDiv.textContent = '⚠ ' + (data.error || 'unknown error')
      scrollBottom()
      break
    }

    case 'done': {
      statusDot.className = 'status-dot idle'
      statusDot.title = 'idle'
      break
    }
  }
}

// Helpers
function esc(s) {
  const d = document.createElement('span')
  d.textContent = s
  return d.innerHTML
}
function toolArgSummary(args) {
  if (!args) return ''
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const first = args[keys[0]]
  const val = typeof first === 'string' ? first : JSON.stringify(first)
  return esc(val.length > 60 ? val.slice(0, 57) + '…' : val)
}

inp.focus()
</script>
</body>
</html>
`

// ── Node.js ShellProvider ────────────────────────────────────────────────

import { spawn as cpSpawn } from "child_process"

class NodeShellProvider {
  platform = process.platform
  private shell: string

  constructor() {
    const s = process.env.SHELL
    // Skip fish/nu shells that have compatibility issues
    const BLACKLIST = new Set(["fish", "nu"])
    if (s && !BLACKLIST.has(path.basename(s))) {
      this.shell = s
    } else {
      this.shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"
    }
  }

  spawn(command: string, opts: { cwd: string; env: Record<string, string | undefined> }) {
    return cpSpawn(command, {
      shell: this.shell,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }) as any
  }

  async kill(proc: any, opts?: { exited?: () => boolean }) {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return
    const SIGKILL_TIMEOUT_MS = 200
    try {
      process.kill(-pid, "SIGTERM")
      await new Promise(r => setTimeout(r, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch {
      proc.kill("SIGTERM")
      await new Promise(r => setTimeout(r, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }
}

// ── Node.js GitProvider ──────────────────────────────────────────────────

class NodeGitProvider {
  async run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    return new Promise<{ exitCode: number; text(): string; stdout: Uint8Array; stderr: Uint8Array }>((resolve) => {
      execFile("git", args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer",
      }, (error: any, stdout: any, stderr: any) => {
        const stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "")
        const stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "")
        resolve({
          exitCode: error ? (error as any).code ?? 1 : 0,
          text: () => stdoutBuf.toString(),
          stdout: new Uint8Array(stdoutBuf),
          stderr: new Uint8Array(stderrBuf),
        })
      })
    })
  }
}

// ── Agent Bootstrap ────────────────────────────────────────────────────────

let agent: InstanceType<typeof CodeAgent>
let currentSessionId: string | null = null

async function initAgent() {
  const agentPaths = makePaths()

  // When using a custom BASE_URL (local proxy), use a non-conflicting
  // provider name to avoid built-in custom loaders.
  // e.g., "openai" loader calls sdk.responses() which doesn't exist
  // on @ai-sdk/openai-compatible. Using "openai-proxy" bypasses that.
  const PROVIDER_ID = BASE_URL ? `${PROVIDER}-proxy` : PROVIDER

  agent = new CodeAgent({
    directory: PROJECT_DIR,
    fs: new NodeFS(),
    search: new NodeSearchProvider(),
    storage: new SqlJsStorage(),
    shell: new NodeShellProvider(),
    git: new NodeGitProvider(),
    dataPath: agentPaths,
    provider: {
      id: PROVIDER_ID,
      apiKey: API_KEY!,
      model: MODEL,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    },
    // Register the model in provider config so arbitrary model IDs work
    // (opencode's built-in registry only knows about models.dev entries)
    config: {
      model: `${PROVIDER_ID}/${MODEL}`,
      // Use the same model for title generation (avoids fallback to gpt-5-nano)
      small_model: `${PROVIDER_ID}/${MODEL}`,
      provider: {
        [PROVIDER_ID]: {
          // Use openai-compatible SDK (standard /v1/chat/completions endpoint)
          npm: "@ai-sdk/openai-compatible",
          ...(BASE_URL ? { api: BASE_URL } : {}),
          // Pass API key directly via options (bypasses env key mapping)
          options: { apiKey: API_KEY },
          models: {
            [MODEL]: {
              name: MODEL,
              attachment: true,
              tool_call: true,
              temperature: true,
              reasoning: false,
              limit: { context: 200000, output: 32000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    },
  })
  await agent.init()
  console.log(`✅  Agent initialized (project: ${PROJECT_DIR})`)
}

// ── HTTP Server ────────────────────────────────────────────────────────────

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = ""
  for await (const chunk of req) body += chunk
  const { message, sessionId } = JSON.parse(body)

  // Always create a fresh session (SqlJsStorage is in-memory, old IDs are invalid after restart)
  if (!currentSessionId) {
    const session = await agent.createSession()
    currentSessionId = session.id
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  // Send session ID first
  res.write(`data: ${JSON.stringify({ sessionId: currentSessionId })}\n\n`)

  try {
    for await (const event of agent.chat(currentSessionId, message)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`)
  }
  res.end()
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res).catch((err) => {
      console.error(err)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: err.message }))
    })
    return
  }

  // Serve HTML
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(HTML)
})

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting CodeAgent dev server…")
  await initAgent()
  server.listen(PORT, () => {
    console.log(`🌐  http://localhost:${PORT}`)
    console.log(`📂  Project: ${PROJECT_DIR}`)
    console.log(`🤖  Provider: ${PROVIDER} / ${MODEL}`)
  })
}

main().catch((err) => {
  console.error("Fatal:", err)
  process.exit(1)
})
