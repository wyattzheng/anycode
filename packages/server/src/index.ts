/**
 * any-code-server — API server for CodeAgent
 *
 * Starts a lightweight HTTP server that:
 *   1. Exposes POST /api/chat (SSE) to stream agent responses
 *   2. Frontend is served separately by the app package
 *
 * Environment variables:
 *   PROVIDER    — LLM provider id  (default: "anthropic")
 *   MODEL       — LLM model id     (default: "claude-sonnet-4-20250514")
 *   API_KEY     — Provider API key  (required)
 *   BASE_URL    — Custom API base URL (optional)
 *   PORT        — HTTP port         (default: 3210)
 */

import http from "http"
import { fileURLToPath } from "url"
import path from "path"
import os from "os"
import fs from "fs"
import fsPromises from "fs/promises"
import { execFile, spawn as cpSpawn } from "child_process"
import { CodeAgent } from "@any-code/agent"
import { WebSocketServer, WebSocket as WS } from "ws"
import { SqlJsStorage } from "./storage-sqljs"
import { NodeFS } from "./vfs-node"
import { NodeSearchProvider } from "./search-node"

// ── Config ─────────────────────────────────────────────────────────────────

const PROVIDER = process.env.PROVIDER ?? "anthropic"
const MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514"
const API_KEY = process.env.API_KEY
const BASE_URL = process.env.BASE_URL
const PORT = parseInt(process.env.PORT ?? "3210", 10)

if (!API_KEY) {
  console.error("❌  Missing API_KEY environment variable")
  console.error("Usage: API_KEY=sk-xxx any-code-server [project-dir]")
  process.exit(1)
}

// ── Paths ──────────────────────────────────────────────────────────────────

function makePaths() {
  const dataPath = path.join(os.homedir(), ".any-code", "data")
  fs.mkdirSync(dataPath, { recursive: true })
  return dataPath
}



// ── Node.js ShellProvider ────────────────────────────────────────────────

class NodeShellProvider {
  platform = process.platform
  private shell: string

  constructor() {
    const s = process.env.SHELL
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
      if (!opts?.exited?.()) process.kill(-pid, "SIGKILL")
    } catch {
      proc.kill("SIGTERM")
      await new Promise(r => setTimeout(r, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) proc.kill("SIGKILL")
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

import { SetDirectory } from "@any-code/agent"

interface SessionEntry {
  id: string
  agent: InstanceType<typeof CodeAgent>
  directory: string  // empty = no project directory set yet
  createdAt: number
}

const sessions = new Map<string, SessionEntry>()

let sessionCounter = 0

function generateSessionId(): string {
  return `ses_${Date.now().toString(36)}_${(++sessionCounter).toString(36)}`
}

const PROVIDER_ID = BASE_URL ? `${PROVIDER}-proxy` : PROVIDER

function createAgentConfig(directory: string) {
  return {
    directory: directory,
    fs: new NodeFS(),
    search: new NodeSearchProvider(),
    storage: new SqlJsStorage(),
    shell: new NodeShellProvider(),
    git: new NodeGitProvider(),
    dataPath: makePaths(),
    provider: {
      id: PROVIDER_ID,
      apiKey: API_KEY!,
      model: MODEL,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    },
    config: {
      model: `${PROVIDER_ID}/${MODEL}`,
      small_model: `${PROVIDER_ID}/${MODEL}`,
      provider: {
        [PROVIDER_ID]: {
          // Use @ai-sdk/anthropic for Claude models — it natively handles
          // thinking blocks and signatures. Other models use openai-compatible.
          npm: /claude/i.test(MODEL) ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
          ...(BASE_URL ? { api: BASE_URL } : {}),
          options: {
            apiKey: API_KEY,
            ...(BASE_URL ? { baseURL: BASE_URL } : {}),
          },
          models: {
            [MODEL]: {
              name: MODEL,
              attachment: true,
              tool_call: true,
              temperature: true,
              reasoning: true,
              limit: { context: 200000, output: 32000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    },
  }
}

async function createSession(directory: string = ""): Promise<SessionEntry> {
  const id = generateSessionId()
  const agent = new CodeAgent(createAgentConfig(directory))
  await agent.init()

  const entry: SessionEntry = { id, agent, directory, createdAt: Date.now() }
  sessions.set(id, entry)

  // Listen for directory.set events from the agent's set_working_directory tool
  agent.bus.subscribe(SetDirectory.Event, (event) => {
    const dir = event.properties.directory
    entry.directory = dir
    try { agent.setWorkingDirectory(dir) } catch { /* already set */ }
    console.log(`📂  Session ${id} directory set to: ${dir}`)
    // Push state to all connected WebSocket clients
    pushState(id)
  })

  // Debounced push after agent goes idle (tool round finished)
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  agent.bus.subscribeAll((payload: any) => {
    if (!payload || !entry.directory) return
    const type = payload.type
    // Push after file edits or when session becomes idle
    if (type === "file.edited" || (type === "session.status.changed" && payload.properties?.status?.type === "idle")) {
      if (pushTimer) clearTimeout(pushTimer)
      pushTimer = setTimeout(() => pushState(id), 300)
    }
  })

  console.log(`✅  Session ${id} created (directory: ${directory || "(none)"})`)
  return entry
}

function getSession(id: string): SessionEntry | undefined {
  return sessions.get(id)
}

// ── File System & Git helpers ──────────────────────────────────────────────

interface DirEntry {
  name: string
  type: "file" | "dir"
}

const IGNORE = new Set([".git", "node_modules", ".next", "dist", ".opencode", ".any-code", "__pycache__", ".venv", ".DS_Store"])

/** List one level of a directory — for lazy tree loading */
async function listDir(dir: string): Promise<DirEntry[]> {
  if (!dir) return []
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e: fs.Dirent) => (!e.name.startsWith(".") || e.name === ".gitignore") && !IGNORE.has(e.name))
      .sort((a: fs.Dirent, b: fs.Dirent) => {
        const ad = a.isDirectory() ? 0 : 1, bd = b.isDirectory() ? 0 : 1
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
      })
      .map((e: fs.Dirent) => ({ name: e.name, type: e.isDirectory() ? "dir" as const : "file" as const }))
  } catch {
    return []
  }
}

interface GitChange {
  file: string
  status: string
}

const gitProvider = new NodeGitProvider()

async function getGitChanges(dir: string): Promise<GitChange[]> {
  if (!dir) return []
  try {
    const result = await gitProvider.run(["status", "--porcelain", "-uall"], { cwd: dir })
    if (result.exitCode !== 0) return []
    const text = result.text()
    if (!text.trim()) return []
    return text
      .split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => {
        const xy = line.slice(0, 2)
        const file = line.slice(3)
        let status = xy.trim().charAt(0) || "?"
        if (xy[0] === "?" || xy[1] === "?") status = "?"
        return { file, status }
      })
  } catch {
    return []
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

// Track WebSocket clients per session
const sessionClients = new Map<string, Set<WS>>()

function getSessionClients(sessionId: string): Set<WS> {
  let set = sessionClients.get(sessionId)
  if (!set) {
    set = new Set()
    sessionClients.set(sessionId, set)
  }
  return set
}

function broadcast(sessionId: string, data: Record<string, unknown>) {
  const clients = sessionClients.get(sessionId)
  if (!clients) return
  const json = JSON.stringify(data)
  for (const ws of clients) {
    if (ws.readyState === WS.OPEN) ws.send(json)
  }
}

/** Push current state (directory + changes) to all clients of a session */
async function pushState(sessionId: string) {
  try {
    const session = getSession(sessionId)
    if (!session) return
    const dir = session.directory
    const changes = dir ? await getGitChanges(dir) : []
    const topLevel = dir ? await listDir(dir) : []
    const clientCount = sessionClients.get(sessionId)?.size ?? 0
    console.log(`📤  pushState(${sessionId}): dir="${dir}", topLevel=${topLevel.length} entries, changes=${changes.length}, clients=${clientCount}`)
    broadcast(sessionId, {
      type: "state",
      directory: dir,
      changes,
      topLevel,
    })
  } catch (err) {
    console.error(`❌  pushState error:`, err)
  }
}

// ── HTTP Server ────────────────────────────────────────────────────────────

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = ""
  for await (const chunk of req) body += chunk
  const { message, sessionId } = JSON.parse(body)

  const session = sessionId ? getSession(sessionId) : undefined
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Session not found" }))
    return
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  try {
    for await (const event of session.agent.chat(message, session.agent.sessionId ?? undefined)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`)
  }
  res.end()
}

// ── Admin UI ───────────────────────────────────────────────────────────────

function adminHTML() {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AnyCode Server Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#1a1b26;--surface:#24283b;--border:#3b4261;--text:#a9b1d6;
    --bright:#c0caf5;--accent:#7aa2f7;--green:#9ece6a;--red:#f7768e;--yellow:#e0af68;
    --mono:'JetBrains Mono','Fira Code','SF Mono',monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  body{font-family:var(--sans);background:var(--bg);color:var(--text);
    min-height:100vh;display:flex;justify-content:center;padding:24px 16px}
  .container{width:100%;max-width:520px}
  h1{font-size:18px;color:var(--bright);margin-bottom:16px;display:flex;align-items:center;gap:8px}
  h1 .dot{width:10px;height:10px;border-radius:50%;background:var(--green);
    animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;
    padding:14px;margin-bottom:10px}
  .card h2{font-size:11px;text-transform:uppercase;letter-spacing:1px;
    color:var(--accent);margin-bottom:10px;font-weight:600}
  .row{display:flex;justify-content:space-between;align-items:center;
    padding:5px 0;border-bottom:1px solid rgba(59,66,97,0.3);font-size:12px}
  .row:last-child{border-bottom:none}
  .label{color:var(--text)}
  .value{color:var(--bright);font-family:var(--mono);font-size:11px}
  .value.green{color:var(--green)} .value.yellow{color:var(--yellow)} .value.red{color:var(--red)}
  .sessions{max-height:200px;overflow-y:auto}
  .session-item{padding:6px 8px;border-bottom:1px solid rgba(59,66,97,0.3);font-size:11px;
    display:flex;justify-content:space-between;align-items:center;cursor:pointer}
  .session-item:hover{background:rgba(122,162,247,0.08)}
  .session-title{color:var(--bright);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .session-status{font-family:var(--mono);font-size:10px;padding:1px 6px;border-radius:3px}
  .session-status.idle{background:rgba(158,206,106,0.15);color:var(--green)}
  .session-status.busy{background:rgba(122,162,247,0.15);color:var(--accent);animation:pulse 1.5s infinite}
  .errors{max-height:120px;overflow-y:auto}
  .error-item{padding:4px 0;border-bottom:1px solid rgba(59,66,97,0.2);font-size:10px;color:var(--red)}
  .error-time{color:var(--text);font-family:var(--mono);margin-right:6px}
  .footer{text-align:center;margin-top:16px;font-size:10px;color:rgba(169,177,214,0.3)}
</style>
</head>
<body>
<div class="container">
  <h1><span class="dot"></span> AnyCode Server</h1>
  <div class="card">
    <h2>⚙ Configuration</h2>
    <div class="row"><span class="label">Provider</span><span class="value">${PROVIDER}</span></div>
    <div class="row"><span class="label">Model</span><span class="value">${MODEL}</span></div>
    <div class="row"><span class="label">Port</span><span class="value">${PORT}</span></div>
    <div class="row"><span class="label">Sessions</span><span class="value" id="session-count">0</span></div>
  </div>
  <div class="card">
    <h2>📊 Runtime Stats</h2>
    <div class="row"><span class="label">Uptime</span><span class="value green" id="uptime">—</span></div>
    <div class="row"><span class="label">Messages</span><span class="value" id="msg-count">0</span></div>
    <div class="row"><span class="label">Tokens (in/out/reason)</span><span class="value" id="tokens">—</span></div>
    <div class="row"><span class="label">Total Cost</span><span class="value yellow" id="cost">$0</span></div>
    <div class="row"><span class="label">Active Session</span><span class="value" id="session">—</span></div>
  </div>
  <div class="card" id="errors-card" style="display:none">
    <h2>⚠ Recent Errors</h2>
    <div class="errors" id="errors"></div>
  </div>
  <div class="footer">any-code-server v0.0.1</div>
</div>
<script>
function fmtK(n){return n>=1000?(n/1000).toFixed(1)+'k':String(n)}
function fmtDur(ms){
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000)
  return h>0?h+'h '+m+'m '+s+'s':m>0?m+'m '+s+'s':s+'s'
}
async function refresh(){
  try{
    const r=await fetch('/api/status');const d=await r.json()
    document.getElementById('uptime').textContent=fmtDur(d.stats.uptimeMs)
    document.getElementById('msg-count').textContent=d.stats.totalMessages
    const t=d.stats.totalTokens
    document.getElementById('tokens').textContent=fmtK(t.input)+' / '+fmtK(t.output)+' / '+fmtK(t.reasoning)
    document.getElementById('cost').textContent='$'+d.stats.totalCost.toFixed(4)
    document.getElementById('session').textContent=d.sessionId||'none'
    const ec=document.getElementById('errors-card'),el=document.getElementById('errors')
    if(d.stats.errors.length>0){
      ec.style.display='block'
      el.innerHTML=d.stats.errors.map(e=>'<div class="error-item"><span class="error-time">'+new Date(e.time).toLocaleTimeString()+'</span>'+e.message.slice(0,80)+'</div>').join('')
    }else{ec.style.display='none'}
  }catch(e){}
}
refresh();setInterval(refresh,2000)
</script>
</body></html>`
}

// ── Static file server for app dist ────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf",
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const APP_DIST = path.resolve(__dirname, "../../app/dist")

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url || "/"
  const filePath = path.join(APP_DIST, url)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath)
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" })
    fs.createReadStream(filePath).pipe(res)
    return true
  }
  return false
}

function serveAppIndex(res: http.ServerResponse): boolean {
  const indexPath = path.join(APP_DIST, "index.html")
  if (fs.existsSync(indexPath)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    fs.createReadStream(indexPath).pipe(res)
    return true
  }
  return false
}

// ── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  // ── API routes ──
  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res).catch((err) => {
      console.error(err)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: err.message }))
    })
    return
  }

  // ── Session management ──
  if (req.method === "POST" && req.url === "/api/sessions") {
    (async () => {
      let body = ""
      for await (const chunk of req) body += chunk
      const { directory } = body ? JSON.parse(body) : { directory: "" }
      createSession(directory || "").then((entry) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: entry.id, directory: entry.directory }))
      }).catch((err: any) => {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      })
    })()
    return
  }

  if (req.method === "GET" && req.url === "/api/sessions") {
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.id, directory: s.directory, createdAt: s.createdAt,
    }))
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(list))
    return
  }

  // GET /api/sessions/:id
  const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/]+)$/)
  if (req.method === "GET" && sessionMatch) {
    const session = getSession(sessionMatch[1])
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Session not found" }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      id: session.id, directory: session.directory, createdAt: session.createdAt,
    }))
    return
  }

  if (req.method === "GET" && req.url === "/api/status") {
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.id, directory: s.directory,
      stats: s.agent.getStats(),
      sessionId: s.agent.sessionId,
    }))
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ sessions: list }))
    return
  }

  // GET /api/messages?sessionId=xxx
  if (req.method === "GET" && req.url?.startsWith("/api/messages")) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const sessionId = url.searchParams.get("sessionId")
    const session = sessionId ? getSession(sessionId) : undefined
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Session not found" }))
      return
    }
    session.agent.getSessionMessages({ limit: 30 }).then((messages: any) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(messages))
    }).catch((err: any) => {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err.message }))
    })
    return
  }

  // ── Admin UI ──
  if (req.method === "GET" && req.url === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(adminHTML())
    return
  }

  // ── Static files from app/dist ──
  if (req.method === "GET") {
    if (serveStatic(req, res)) return
    if (serveAppIndex(res)) return
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "Not found" }))
})

// ── Main ───────────────────────────────────────────────────────────────────

export async function startServer() {
  console.log("🚀  Starting any-code-server…")
  const appDistExists = fs.existsSync(APP_DIST)

  // ── WebSocket server on same HTTP server ──
  const wss = new WebSocketServer({ server })
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`)
    const sessionId = url.searchParams.get("sessionId")
    if (!sessionId || !getSession(sessionId)) {
      ws.close(4001, "Invalid session")
      return
    }

    const clients = getSessionClients(sessionId)
    clients.add(ws)
    console.log(`🔌  WS client connected to session ${sessionId} (${clients.size} total)`)

    // Push current state immediately on connect
    pushState(sessionId)

    // Handle client messages (e.g. ls requests)
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "ls") {
          // Lazy load: list one directory level
          const session = getSession(sessionId)!
          const dir = session.directory
          if (!dir) return
          const target = path.resolve(dir, msg.path || "")
          // Security: must be under project directory
          if (!target.startsWith(path.resolve(dir))) return
          const entries = await listDir(target)
          ws.send(JSON.stringify({ type: "ls", path: msg.path || "", entries }))
        }
      } catch { /* ignore malformed */ }
    })

    ws.on("close", () => {
      clients.delete(ws)
      if (clients.size === 0) sessionClients.delete(sessionId)
    })
  })

  const HOST = process.env.HOST ?? "0.0.0.0"

  server.listen(PORT, HOST, () => {
    console.log(`🌐  http://${HOST}:${PORT}`)
    console.log(`🤖  Provider: ${PROVIDER} / ${MODEL}`)
    console.log(`🖥  Admin: http://${HOST}:${PORT}/admin`)
    if (appDistExists) {
      console.log(`📱  App: http://${HOST}:${PORT}`)
    } else {
      console.log(`⚠  App dist not found at ${APP_DIST} — run 'pnpm --filter app build' first`)
    }
    console.log(`📋  Sessions: POST /api/sessions to create`)
    console.log(`🔌  WebSocket: ws://${HOST}:${PORT}?sessionId=xxx`)
  })
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider }

