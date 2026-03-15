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
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --red: #f85149; --mono: 'SF Mono', 'Fira Code', monospace;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex;
    align-items: center; gap: 10px; background: var(--surface); }
  header h1 { font-size: 15px; font-weight: 600; }
  header .badge { font-size: 11px; background: var(--accent); color: #000; padding: 2px 8px;
    border-radius: 10px; font-weight: 600; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px;
    line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .msg.user { align-self: flex-end; background: #1f6feb; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: var(--surface); border: 1px solid var(--border);
    border-bottom-left-radius: 4px; }
  .msg.tool { align-self: flex-start; background: #1c2128; border-left: 3px solid var(--green);
    font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .msg.error { align-self: flex-start; background: #2d1215; border-left: 3px solid var(--red);
    color: var(--red); }
  #input-bar { padding: 12px 16px; border-top: 1px solid var(--border); background: var(--surface);
    display: flex; gap: 8px; }
  #input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px 14px; color: var(--text); font-size: 14px; outline: none; resize: none;
    font-family: inherit; min-height: 42px; max-height: 120px; }
  #input:focus { border-color: var(--accent); }
  #send { background: var(--accent); color: #000; border: none; border-radius: 8px;
    padding: 10px 20px; font-weight: 600; font-size: 14px; cursor: pointer; transition: opacity .15s; }
  #send:hover { opacity: .85; }
  #send:disabled { opacity: .4; cursor: not-allowed; }
</style>
</head>
<body>
<header>
  <h1>🤖 CodeAgent Dev</h1>
  <span class="badge">${PROVIDER} / ${MODEL}</span>
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
let sessionId = null
let busy = false

function addMsg(cls, text) {
  const d = document.createElement('div')
  d.className = 'msg ' + cls
  d.textContent = text
  msgs.appendChild(d)
  msgs.scrollTop = msgs.scrollHeight
  return d
}

async function send() {
  const text = inp.value.trim()
  if (!text || busy) return
  inp.value = ''
  addMsg('user', text)
  busy = true; btn.disabled = true

  let assistantEl = null

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
        const data = JSON.parse(line.slice(6))
        if (data.sessionId) sessionId = data.sessionId
        if (data.type === 'text_delta') {
          if (!assistantEl) assistantEl = addMsg('assistant', '')
          assistantEl.textContent += data.content ?? ''
          msgs.scrollTop = msgs.scrollHeight
        }
        if (data.type === 'tool_call_start') addMsg('tool', '⚙ ' + data.toolName + ' …')
        if (data.type === 'tool_call_done') addMsg('tool', '✓ ' + data.toolName + ' done')
        if (data.type === 'error') addMsg('error', '⚠ ' + (data.error ?? 'unknown error'))
        if (data.type === 'done') { /* finished */ }
      }
    }
  } catch (e) {
    addMsg('error', '⚠ ' + e.message)
  }
  busy = false; btn.disabled = false; inp.focus()
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
