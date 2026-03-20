/**
 * @any-code/server — API server for CodeAgent
 *
 * Starts a lightweight HTTP server that:
 *   1. Chat is handled via WebSocket (broadcast to all clients)
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
import { CodeAgent, Database, type NoSqlDb, type TerminalProvider, type PreviewProvider } from "@any-code/agent"
import { WebSocketServer, WebSocket as WS } from "ws"
// @ts-expect-error — @lydell/node-pty has types but exports config doesn't expose them
import * as pty from "@lydell/node-pty"
import { SqlJsStorage } from "./storage-sqljs"
import { NodeFS } from "./vfs-node"
import { NodeSearchProvider } from "./search-node"

// ── Paths ──────────────────────────────────────────────────────────────────

const ANYCODE_DIR = path.join(os.homedir(), ".anycode")
const DB_PATH = path.join(ANYCODE_DIR, "data.db")
interface ServerConfig {
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  port: number
  previewPort: number
  appDist: string
  userSettings: Record<string, any>
}

function loadConfig(): ServerConfig {
  let userSettings: Record<string, any> = {}
  try {
    userSettings = JSON.parse(fs.readFileSync(path.join(ANYCODE_DIR, "settings.json"), "utf-8"))
  } catch { }
  const provider = process.env.PROVIDER ?? userSettings.PROVIDER ?? "anthropic";
  const model = process.env.MODEL ?? userSettings.MODEL ?? "claude-sonnet-4-20250514"
  const apiKey = process.env.API_KEY ?? userSettings.API_KEY ?? ""
  const baseUrl = process.env.BASE_URL ?? userSettings.BASE_URL ?? ""
  const port = parseInt(process.env.PORT ?? "3210", 10)
  const previewPort = parseInt(process.env.PREVIEW_PORT ?? String(port + 1), 10)
  if (!provider || !model || !baseUrl) {
    console.error("❌  Missing PROVIDER, MODEL, BASE_URL")
    process.exit(1)
  }
  if (!apiKey) {
    console.error("❌  Missing API_KEY")
    console.error("Run 'anycode start' to configure, or set API_KEY env var.")
    process.exit(1)
  }
  const appDist = resolveAppDist()
  return { provider, model, apiKey, baseUrl, port, previewPort, appDist, userSettings }
}

// ── Global error handlers — registered inside startServer() ──

function makePaths() {
  const dataPath = path.join(ANYCODE_DIR, "data")
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



interface SessionEntry {
  id: string
  agent: InstanceType<typeof CodeAgent>
  directory: string  // empty = no project directory set yet
  createdAt: number
}

// In-memory agent cache, keyed by session ID
const sessions = new Map<string, SessionEntry>()

// PROVIDER_ID removed — use cfg.provider

// Shared storage & DB — initialised lazily inside startServer()
let sharedStorage: SqlJsStorage
let db: NoSqlDb

function createAgentConfig(cfg: ServerConfig, directory: string, sessionId?: string, terminal?: TerminalProvider, preview?: PreviewProvider) {
  return {
    directory: directory,
    fs: new NodeFS(),
    search: new NodeSearchProvider(),
    storage: sharedStorage,
    shell: new NodeShellProvider(),
    git: new NodeGitProvider(),
    dataPath: makePaths(),
    ...(sessionId ? { sessionId } : {}),
    ...(terminal ? { terminal } : {}),
    ...(preview ? { preview } : {}),
    provider: {
      id: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    },
    settings: cfg.userSettings,
    config: {
      model: `${cfg.provider}/${cfg.model}`,
      small_model: `${cfg.provider}/${cfg.model}`,
      provider: {
        [cfg.provider]: {
          npm: /claude/i.test(cfg.model) ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
          ...(cfg.baseUrl ? { api: cfg.baseUrl } : {}),
          options: {
            apiKey: cfg.apiKey,
            ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
          },
          models: {
            [cfg.model]: {
              name: cfg.model,
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

/** Wire up agent events and register in sessions map. */
function registerSession(cfg: ServerConfig, id: string, agent: InstanceType<typeof CodeAgent>, directory: string, createdAt: number): SessionEntry {
  const entry: SessionEntry = { id, agent, directory, createdAt }
  sessions.set(id, entry)

  // Listen for directory.set events from the agent's set_working_directory tool
  agent.on("directory.set", (data: any) => {
    const dir = data.directory
    entry.directory = dir
    try { agent.setWorkingDirectory(dir) } catch { /* already set */ }
    // Persist directory back to user_session mapping
    db.update("user_session", { op: "eq", field: "session_id", value: id }, { directory: dir })
    console.log(`📂  Session ${id} directory set to: ${dir}`)
    pushState(cfg, id)
    watchDirectory(cfg, id, dir)
  })

  return entry
}

/**
 * Resume a persisted session row into memory.
 */
async function resumeSession(cfg: ServerConfig, row: Record<string, unknown>): Promise<SessionEntry> {
  const sessionId = row.session_id as string
  const cached = sessions.get(sessionId)
  if (cached) return cached

  const dir = (row.directory as string) || ""
  const tp = getOrCreateTerminalProvider(sessionId)
  const pp = getOrCreatePreviewProvider(cfg, sessionId)
  const agent = new CodeAgent(createAgentConfig(cfg, dir, sessionId, tp, pp))
  await agent.init()
  const entry = registerSession(cfg, sessionId, agent, dir, row.time_created as number)
  if (dir) {
    try { agent.setWorkingDirectory(dir) } catch { /* already set */ }
    watchDirectory(cfg, sessionId, dir)
  }
  console.log(`♻️  Session ${sessionId} resumed`)
  return entry
}

/**
 * Create a brand new session/window for a user.
 */
async function createNewWindow(cfg: ServerConfig, userId: string, isDefault = false): Promise<SessionEntry> {
  const tempId = `temp-${Date.now()}`
  const tp = getOrCreateTerminalProvider(tempId)
  const pp = getOrCreatePreviewProvider(cfg, tempId)
  const agent = new CodeAgent(createAgentConfig(cfg, "", undefined, tp, pp))
  await agent.init()
  const sessionId = agent.sessionId
  const now = Date.now()
  terminalProviders.delete(tempId)
  terminalProviders.set(sessionId, tp)
  previewProviders.delete(tempId)
  previewProviders.set(sessionId, pp)
    ; (tp as any).sessionId = sessionId
    ; (pp as any).sessionId = sessionId
  const entry = registerSession(cfg, sessionId, agent, "", now)

  db.insert("user_session", {
    user_id: userId,
    session_id: sessionId,
    directory: "",
    time_created: now,
    is_default: isDefault ? 1 : 0,
  })

  console.log(`✅  Window ${sessionId} created for user ${userId}${isDefault ? " (default)" : ""}`)
  return entry
}

/**
 * Get or create the default window for a user.
 * Returns the default session; creates one if none exists.
 */
async function getOrCreateSession(cfg: ServerConfig, userId: string): Promise<SessionEntry> {
  // Find default window
  const rows = db.findMany("user_session", { filter: { op: "eq", field: "user_id", value: userId } })
  const defaultRow = rows.find((r: any) => r.is_default === 1) || rows[0]

  if (defaultRow) {
    // Ensure is_default is set on the row if it was a legacy row without it
    if (defaultRow.is_default !== 1) {
      db.update("user_session", { op: "eq", field: "session_id", value: defaultRow.session_id }, { is_default: 1 })
    }
    return resumeSession(cfg, defaultRow)
  }

  return createNewWindow(cfg, userId, true)
}

/**
 * Get all windows for a user. Resumes any that aren't in memory.
 */
async function getAllWindows(cfg: ServerConfig, userId: string): Promise<SessionEntry[]> {
  const rows = db.findMany("user_session", { filter: { op: "eq", field: "user_id", value: userId } })
  const entries: SessionEntry[] = []
  for (const row of rows) {
    entries.push(await resumeSession(cfg, row))
  }
  return entries
}

/**
 * Delete a non-default window.
 */
function deleteWindow(sessionId: string): boolean {
  const row = db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
  if (!row) return false
  if ((row as any).is_default === 1) return false // cannot delete default

  // Clean up in-memory state
  const session = sessions.get(sessionId)
  if (session) {
    sessions.delete(sessionId)
  }
  const tp = terminalProviders.get(sessionId)
  if (tp && tp.exists()) {
    try { tp.destroy() } catch { /* ignore */ }
  }
  terminalProviders.delete(sessionId)

  // Remove from DB
  db.remove("user_session", { op: "eq", field: "session_id", value: sessionId })
  console.log(`🗑  Window ${sessionId} deleted`)
  return true
}

function getSession(id: string): SessionEntry | undefined {
  return sessions.get(id)
}

// ── File System & Git helpers ──────────────────────────────────────────────

interface DirEntry {
  name: string
  type: "file" | "dir"
}

const IGNORE = new Set([".git", "node_modules", ".next", "dist", ".opencode", ".anycode", ".any-code", "__pycache__", ".venv", ".DS_Store"])

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

// ── Channel abstraction ───────────────────────────────────────────────────

/** Minimal interface shared by WebSocket and PollingClient */
interface ClientLike {
  readyState: number
  send(data: string): void
}

// Track clients per session (WebSocket or PollingClient)
const sessionClients = new Map<string, Set<ClientLike>>()

// Track active chat abort functions per session
const sessionChatAbort = new Map<string, () => void>()

// Cached last-pushed state JSON per session — used for diffing + replay to new clients
const lastStateJson = new Map<string, string>()
const statePushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleStatePush(cfg: ServerConfig, sessionId: string, delayMs = 300) {
  const existing = statePushTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    statePushTimers.delete(sessionId)
    void pushState(cfg, sessionId)
  }, delayMs)
  statePushTimers.set(sessionId, timer)
}

function getSessionClients(sessionId: string): Set<ClientLike> {
  let set = sessionClients.get(sessionId)
  if (!set) {
    set = new Set()
    sessionClients.set(sessionId, set)
  }
  return set
}

function removeClient(sessionId: string, client: ClientLike) {
  const clients = sessionClients.get(sessionId)
  if (clients) {
    clients.delete(client)
    if (clients.size === 0) sessionClients.delete(sessionId)
  }
}

function broadcast(sessionId: string, data: Record<string, unknown>) {
  const clients = sessionClients.get(sessionId)
  if (!clients) return
  const json = JSON.stringify(data)
  for (const c of clients) {
    if (c.readyState === WS.OPEN) c.send(json)
  }
}

// ── HTTP Long-Polling server-side client ──────────────────────────────────

class PollingClient implements ClientLike {
  readyState = 1 // OPEN
  readonly id: string
  readonly sessionId: string
  lastActivity: number

  private queue: string[] = []
  private pendingRes: http.ServerResponse | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(id: string, sessionId: string) {
    this.id = id
    this.sessionId = sessionId
    this.lastActivity = Date.now()
  }

  /** Called by broadcast — queues a JSON string for the next poll */
  send(data: string) {
    this.queue.push(data)
    this.tryFlush()
  }

  /** Attach a long-poll response. Flushes immediately if messages are queued. */
  hold(res: http.ServerResponse, timeoutMs = 30000) {
    this.lastActivity = Date.now()
    this.abortPoll()
    this.pendingRes = res
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      this.flush()
    }, timeoutMs)
    // Handle client disconnect mid-poll
    res.on("close", () => {
      if (this.pendingRes === res) {
        if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
        this.pendingRes = null
      }
    })
    this.tryFlush()
  }

  close() {
    this.readyState = 3 // CLOSED
    this.abortPoll()
    this.queue = []
  }

  private tryFlush() {
    if (!this.pendingRes || this.queue.length === 0) return
    this.flush()
  }

  private flush() {
    if (!this.pendingRes) return
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    const messages = this.queue.splice(0)
    this.pendingRes.writeHead(200, { "Content-Type": "application/json" })
    // Each item is already a JSON string — construct array without re-serializing
    this.pendingRes.end(`[${messages.join(",")}]`)
    this.pendingRes = null
  }

  private abortPoll() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this.pendingRes) {
      this.pendingRes.writeHead(200, { "Content-Type": "application/json" })
      this.pendingRes.end("[]")
      this.pendingRes = null
    }
  }
}

const pollingClients = new Map<string, PollingClient>() // channelId → PollingClient

/** Shared message handler — used by both WebSocket and HTTP polling */
async function handleClientMessage(sessionId: string, client: ClientLike, msg: any) {
  if (msg.type === "ls") {
    const session = getSession(sessionId)!
    const dir = session.directory
    if (!dir) return
    const target = path.resolve(dir, msg.path || "")
    if (!target.startsWith(path.resolve(dir))) return
    const entries = await listDir(target)
    client.send(JSON.stringify({ type: "ls", path: msg.path || "", entries }))
  }

  if (msg.type === "readFile") {
    const session = getSession(sessionId)!
    const dir = session.directory
    if (!dir) return
    const target = path.resolve(dir, msg.path || "")
    if (!target.startsWith(path.resolve(dir))) return
    try {
      const content = await fsPromises.readFile(target, "utf-8")
      client.send(JSON.stringify({ type: "fileContent", path: msg.path || "", content }))
    } catch {
      client.send(JSON.stringify({ type: "fileContent", path: msg.path || "", content: null, error: "读取失败" }))
    }
  }

  if (msg.type === "chat.send") {
    const session = getSession(sessionId)
    if (!session) return
    const { message, fileContext } = msg

    let effectiveMessage = message
    if (fileContext?.file && Array.isArray(fileContext.lines) && fileContext.lines.length > 0) {
      const lines = fileContext.lines as number[]
      const start = lines[0]
      const end = lines[lines.length - 1]
      const range = start === end ? `L${start}` : `L${start}–${end}`
      effectiveMessage = `[用户选中了文件 ${fileContext.file} 的 ${range} 行]\n\n${message}`
    }

    const contextLabel = fileContext
      ? `[${fileContext.file} L${fileContext.lines[0]}–${fileContext.lines[fileContext.lines.length - 1]}]\n${message}`
      : message

    broadcast(sessionId, { type: "chat.userMessage", text: contextLabel })

    let aborted = false
    sessionChatAbort.set(sessionId, () => { aborted = true })

    try {
      for await (const event of session.agent.chat(effectiveMessage)) {
        if (aborted) break
        broadcast(sessionId, { type: "chat.event", event })
      }
    } catch (err: any) {
      broadcast(sessionId, { type: "chat.event", event: { type: "error", error: err.message } })
    }

    sessionChatAbort.delete(sessionId)
    broadcast(sessionId, { type: "chat.done" })
  }

  if (msg.type === "chat.stop") {
    sessionChatAbort.get(sessionId)?.()
  }
}

// ── fs.watch-based directory watcher ──────────────────────────────────────

const watchers = new Map<string, fs.FSWatcher>()

function watchDirectory(cfg: ServerConfig, sessionId: string, dir: string) {
  // Clean up existing watcher for this session
  const existing = watchers.get(sessionId)
  if (existing) existing.close()

  const debouncedPush = () => {
    scheduleStatePush(cfg, sessionId, 500)
  }

  try {
    // macOS and Windows support recursive: true natively
    const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      // Ignore .git internals (too noisy), node_modules, etc.
      if (filename && (filename.startsWith(".git/") || filename.startsWith("node_modules/"))) return
      debouncedPush()
    })
    watchers.set(sessionId, watcher)
    console.log(`👁  Watching directory: ${dir}`)
  } catch (err) {
    console.error(`❌  fs.watch failed for ${dir}:`, err)
  }
}

/** Build current state payload for a session */
async function buildState(cfg: ServerConfig, sessionId: string): Promise<Record<string, unknown> | null> {
  const session = getSession(sessionId)
  if (!session) return null
  const dir = session.directory
  const changes = dir ? await getGitChanges(dir) : []
  const topLevel = dir ? await listDir(dir) : []
  return {
    type: "state",
    directory: dir,
    changes,
    topLevel,
    previewPort: (previewSessionId === sessionId && previewTarget) ? cfg.previewPort : null,
  }
}

/** Push current state to all clients — only if data actually changed */
async function pushState(cfg: ServerConfig, sessionId: string) {
  try {
    const payload = await buildState(cfg, sessionId)
    if (!payload) return
    const json = JSON.stringify(payload)
    const prev = lastStateJson.get(sessionId)
    if (prev === json) return // nothing changed — skip
    lastStateJson.set(sessionId, json)
    const clientCount = sessionClients.get(sessionId)?.size ?? 0
    console.log(`📤  pushState(${sessionId}): dir="${payload.directory}", topLevel=${(payload.topLevel as any[]).length} entries, changes=${(payload.changes as any[]).length}, clients=${clientCount}`)
    // Broadcast pre-serialised JSON directly
    const clients = sessionClients.get(sessionId)
    if (!clients) return
    for (const c of clients) {
      if (c.readyState === WS.OPEN) c.send(json)
    }
  } catch (err) {
    console.error(`❌  pushState error:`, err)
  }
}

/** Send cached state to a single client (for initial connect). If no cache, compute fresh. */
async function sendStateTo(cfg: ServerConfig, sessionId: string, client: ClientLike) {
  try {
    let json = lastStateJson.get(sessionId)
    if (!json) {
      const payload = await buildState(cfg, sessionId)
      if (!payload) return
      json = JSON.stringify(payload)
      lastStateJson.set(sessionId, json)
    }
    if (client.readyState === WS.OPEN) client.send(json)
  } catch (err) {
    console.error(`❌  sendStateTo error:`, err)
  }
}

// ── Terminal PTY — shared between agent and user (WebSocket) ────────────────

/** Strip ANSI escape sequences so the agent sees clean text */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "")
}

const MAX_BUFFER_LINES = 5000

/**
 * NodeTerminalProvider — per-session shared terminal.
 *
 * Manages a single PTY process, a scrollback buffer (for agent reads),
 * and a set of WebSocket clients (for user UI).
 */
const MAX_RAW_BUFFER = 200

class NodeTerminalProvider implements TerminalProvider {
  private proc: pty.IPty | null = null
  private lines: string[] = []
  private currentLine = ""
  private rawBuffer: string[] = []
  private wsClients = new Set<WS>()
  private sessionId: string

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  exists(): boolean {
    return this.proc !== null
  }

  create(): void {
    if (this.proc) throw new Error("Terminal already exists. Destroy it first.")
    const session = getSession(this.sessionId)
    const cwd = session?.directory || os.homedir()
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash")

    // Validate cwd exists
    if (!fs.existsSync(cwd)) {
      throw new Error(`Terminal cwd does not exist: ${cwd}`)
    }

    console.log(`🖥  Terminal creating: shell=${shell}, cwd=${cwd}, sessionId=${this.sessionId}`)

    this.lines = []
    this.currentLine = ""
    this.rawBuffer = []

    // Filter out undefined env values (node-pty requires string values)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    env.PROMPT_EOL_MARK = ""  // suppress zsh partial-line marker
    env.CLICOLOR = "1"        // enable colored ls output on macOS
    env.CLICOLOR_FORCE = "1"  // force colors even if not a tty
    env.LSCOLORS = "GxFxCxDxBxegedabagaced"  // default macOS ls colors

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    })

    console.log(`🖥  Terminal created for session ${this.sessionId} (pid ${proc.pid}, cwd ${cwd})`)

    proc.onData((data: string) => {
      // 1. Append to line buffer (strip ANSI for agent reads)
      this.appendToBuffer(data)
      // 2. Cache raw output for replay on WS reconnect
      this.rawBuffer.push(data)
      if (this.rawBuffer.length > MAX_RAW_BUFFER) {
        this.rawBuffer.splice(0, this.rawBuffer.length - MAX_RAW_BUFFER)
      }
      // 3. Forward raw data to all connected WS clients (keep ANSI for xterm.js)
      for (const ws of this.wsClients) {
        if (ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: "terminal.output", data }))
        }
      }
    })

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`🖥  Terminal exited for session ${this.sessionId} (code ${exitCode})`)
      this.proc = null
      for (const ws of this.wsClients) {
        if (ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: "terminal.exited", exitCode }))
          ws.send(JSON.stringify({ type: "terminal.none" }))
        }
      }
    })

    this.proc = proc

    // Notify all WS clients that terminal is now ready
    for (const ws of this.wsClients) {
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ type: "terminal.ready" }))
      }
    }
  }

  destroy(): void {
    if (!this.proc) throw new Error("No terminal exists.")
    console.log(`🖥  Terminal destroyed for session ${this.sessionId}`)
    this.proc.kill()
    this.proc = null
    this.lines = []
    this.currentLine = ""
    this.rawBuffer = []
    for (const ws of this.wsClients) {
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ type: "terminal.none" }))
      }
    }
  }

  write(data: string): void {
    if (!this.proc) throw new Error("No terminal exists.")
    this.proc.write(data)
  }

  read(lineCount: number): string {
    if (!this.proc) throw new Error("No terminal exists.")
    // Include the current partial line if non-empty
    const allLines = this.currentLine
      ? [...this.lines, this.currentLine]
      : [...this.lines]
    const start = Math.max(0, allLines.length - lineCount)
    return allLines.slice(start).join("\n")
  }

  /** Resize the PTY (called from WS client) */
  resize(cols: number, rows: number): void {
    if (this.proc && cols > 0 && rows > 0) {
      this.proc.resize(cols, rows)
    }
  }

  /** Get buffered raw output for replay */
  getRawBuffer(): string[] {
    return this.rawBuffer
  }

  /** Register a WebSocket client for live output */
  addClient(ws: WS): void {
    this.wsClients.add(ws)
  }

  /** Unregister a WebSocket client */
  removeClient(ws: WS): void {
    this.wsClients.delete(ws)
  }

  /** Handle input from a WebSocket client */
  handleWsMessage(raw: Buffer | string): void {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === "terminal.input" && this.proc) {
        this.proc.write(msg.data)
      } else if (msg.type === "terminal.resize") {
        this.resize(msg.cols, msg.rows)
      }
    } catch { /* ignore malformed */ }
  }

  private appendToBuffer(data: string) {
    const clean = stripAnsi(data)
    // Split on \n only (real newlines)
    const lines = clean.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const segment = lines[i]
      if (i === 0) {
        // First segment appends to current partial line
        this.handleCR(segment)
      } else {
        // \n means the previous line is complete
        this.lines.push(this.currentLine)
        this.currentLine = ""
        this.handleCR(segment)
        // Trim buffer
        if (this.lines.length > MAX_BUFFER_LINES) {
          this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES)
        }
      }
    }
  }

  /** Handle \r within a segment: text after the last \r overwrites from column 0 */
  private handleCR(segment: string) {
    const crParts = segment.split("\r")
    if (crParts.length === 1) {
      // No \r — just append
      this.currentLine += segment
    } else {
      // Each \r resets to column 0; last part wins (overwrites)
      for (const part of crParts) {
        if (part === "") continue
        // Overwrite from column 0, keep trailing content if new part is shorter
        if (part.length >= this.currentLine.length) {
          this.currentLine = part
        } else {
          this.currentLine = part + this.currentLine.slice(part.length)
        }
      }
    }
  }
}

// Per-session terminal providers
const terminalProviders = new Map<string, NodeTerminalProvider>()

function getOrCreateTerminalProvider(sessionId: string): NodeTerminalProvider {
  let tp = terminalProviders.get(sessionId)
  if (!tp) {
    tp = new NodeTerminalProvider(sessionId)
    terminalProviders.set(sessionId, tp)
  }
  return tp
}

function handleTerminalWs(ws: WS, sessionId: string) {
  const tp = getOrCreateTerminalProvider(sessionId)
  tp.addClient(ws)

  // Notify client of current terminal state and replay buffer
  if (tp.exists()) {
    ws.send(JSON.stringify({ type: "terminal.ready" }))
    // Replay buffered output so late-connecting clients see prior output
    for (const chunk of tp.getRawBuffer()) {
      ws.send(JSON.stringify({ type: "terminal.output", data: chunk }))
    }
  } else {
    ws.send(JSON.stringify({ type: "terminal.none" }))
  }

  ws.on("message", (raw: Buffer | string) => tp.handleWsMessage(raw))

  ws.on("close", () => {
    tp.removeClient(ws)
    console.log(`🖥  Terminal WS closed for session ${sessionId}`)
  })
}

// ── Preview Provider — dedicated preview port with full reverse proxy ─────

/** Stores the current preview target URL. Only one active target at a time. */
let previewTarget: string | null = null
let previewSessionId: string | null = null

class NodePreviewProvider implements PreviewProvider {
  sessionId: string

  private cfg: ServerConfig
  constructor(cfg: ServerConfig, sessionId: string) {
    this.cfg = cfg
    this.sessionId = sessionId
  }

  setPreviewTarget(forwardedLocalUrl: string): void {
    previewTarget = forwardedLocalUrl.replace(/\/+$/, "")
    previewSessionId = this.sessionId
    console.log(`🔗  Preview proxy: :${this.cfg.previewPort} → ${previewTarget} (session ${this.sessionId})`)

    // Broadcast preview port to frontend
    broadcast(this.sessionId, {
      type: "preview",
      port: this.cfg.previewPort,
    })
  }
}

const previewProviders = new Map<string, NodePreviewProvider>()

function getOrCreatePreviewProvider(cfg: ServerConfig, sessionId: string): NodePreviewProvider {
  let pp = previewProviders.get(sessionId)
  if (!pp) {
    pp = new NodePreviewProvider(cfg, sessionId)
    previewProviders.set(sessionId, pp)
  }
  return pp
}

/** Dedicated preview HTTP server — proxies all requests to the current target */
function createPreviewServer(cfg: ServerConfig): http.Server {
  const previewServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    if (!previewTarget) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("No preview target configured")
      return
    }

    try {
      const targetUrl = previewTarget + (req.url || "/")
      const parsed = new URL(targetUrl)
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: parsed.host },
      }

      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
        proxyRes.pipe(res)
      })

      proxyReq.on("error", (err) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
        res.end(`Preview proxy error: ${err.message}`)
      })

      req.pipe(proxyReq)
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end(`Invalid proxy target: ${err.message}`)
    }
  })

  // WebSocket upgrade proxy — needed for HMR (Vite, webpack, etc.)
  previewServer.on("upgrade", (req, socket, head) => {
    if (!previewTarget) {
      socket.destroy()
      return
    }

    try {
      const parsed = new URL(previewTarget)
      const targetWs = `ws://${parsed.hostname}:${parsed.port}${req.url || "/"}`
      const wsTarget = new URL(targetWs)

      const options: http.RequestOptions = {
        hostname: wsTarget.hostname,
        port: wsTarget.port,
        path: wsTarget.pathname + wsTarget.search,
        method: "GET",
        headers: { ...req.headers, host: wsTarget.host },
      }

      const proxyReq = http.request(options)

      proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          Object.entries(_proxyRes.headers)
            .filter(([k]) => !["upgrade", "connection"].includes(k.toLowerCase()))
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n"
        )
        if (proxyHead.length > 0) socket.write(proxyHead)
        proxySocket.pipe(socket)
        socket.pipe(proxySocket)
      })

      proxyReq.on("error", () => socket.destroy())
      socket.on("error", () => proxyReq.destroy())

      proxyReq.end()
    } catch {
      socket.destroy()
    }
  })
  return previewServer
}

// ── HTTP Server ────────────────────────────────────────────────────────────

// ── Admin UI ───────────────────────────────────────────────────────────────

function adminHTML(cfg: ServerConfig) {
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
    <div class="row"><span class="label">Provider</span><span class="value">${cfg.provider}</span></div>
    <div class="row"><span class="label">Model</span><span class="value">${cfg.model}</span></div>
    <div class="row"><span class="label">Port</span><span class="value">${cfg.port}</span></div>
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
  <div class="footer">@any-code/server v0.0.1</div>
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

function resolveAppDist(): string {
  // 1. Bundled CLI — app dist is copied alongside the server bundle
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "app")
  if (fs.existsSync(path.join(bundled, "index.html"))) return bundled

  // 2. Monorepo dev — resolve from workspace package
  try {
    const resolved = path.dirname(fileURLToPath(import.meta.resolve("@any-code/app/index.html")))
    if (fs.existsSync(path.join(resolved, "index.html"))) return resolved
  } catch { }

  return bundled // fallback (will show "App dist not found" warning)
}

// APP_DIST removed from module scope — use cfg.appDist

function serveStatic(cfg: ServerConfig, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const url = req.url || "/"
  const filePath = path.join(cfg.appDist, url)
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath)
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" })
    fs.createReadStream(filePath).pipe(res)
    return true
  }
  return false
}

function serveAppIndex(cfg: ServerConfig, res: http.ServerResponse): boolean {
  const indexPath = path.join(cfg.appDist, "index.html")
  if (fs.existsSync(indexPath)) {
    const webSocket = cfg.userSettings.webSocket === true // default false → polling
    const configScript = `<script>window.__ANYCODE_CONFIG__=${JSON.stringify({ webSocket })}</script>`
    let html = fs.readFileSync(indexPath, "utf-8")
    html = html.replace("</head>", `${configScript}</head>`)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
    return true
  }
  return false
}

// ── HTTP Server ────────────────────────────────────────────────────────────

function createMainServer(cfg: ServerConfig): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    // ── HTTP Long-Polling endpoints ──

    // POST /api/poll/connect — create a polling channel
    if (req.method === "POST" && req.url === "/api/poll/connect") {
      let body = ""
      for await (const chunk of req) body += chunk
      const { sessionId } = body ? JSON.parse(body) : {} as any
      const session = sessionId ? getSession(sessionId) : undefined
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Session not found" }))
        return
      }
      const channelId = Math.random().toString(36).slice(2) + Date.now().toString(36)
      const client = new PollingClient(channelId, sessionId)
      pollingClients.set(channelId, client)
      getSessionClients(sessionId).add(client)
      console.log(`🔌  Poll client connected to session ${sessionId} (channel=${channelId})`)
      sendStateTo(cfg, sessionId, client)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ channelId }))
      return
    }

    // GET /api/poll?channelId=xxx — long poll for messages
    if (req.method === "GET" && req.url?.startsWith("/api/poll?")) {
      const url = new URL(req.url, `http://localhost:${cfg.port}`)
      const channelId = url.searchParams.get("channelId")
      const client = channelId ? pollingClients.get(channelId) : undefined
      if (!client || client.readyState !== 1) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Channel not found" }))
        return
      }
      client.hold(res)
      return
    }

    // POST /api/poll/send — send a message from client to server
    if (req.method === "POST" && req.url === "/api/poll/send") {
      let body = ""
      for await (const chunk of req) body += chunk
      const { channelId, data } = body ? JSON.parse(body) : {} as any
      const client = channelId ? pollingClients.get(channelId) : undefined
      if (!client || client.readyState !== 1) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Channel not found" }))
        return
      }
      client.lastActivity = Date.now()
      // Fire-and-forget — response goes through poll, not this request
      handleClientMessage(client.sessionId, client, data).catch(() => { })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // POST /api/poll/close — close a polling channel
    if (req.method === "POST" && req.url === "/api/poll/close") {
      let body = ""
      for await (const chunk of req) body += chunk
      const { channelId } = body ? JSON.parse(body) : {} as any
      const client = channelId ? pollingClients.get(channelId) : undefined
      if (client) {
        client.close()
        removeClient(client.sessionId, client)
        pollingClients.delete(channelId!)
        console.log(`🔌  Poll client disconnected (channel=${channelId})`)
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    // ── Session management ──
    if (req.method === "POST" && req.url === "/api/sessions") {
      (async () => {
        let body = ""
        for await (const chunk of req) body += chunk
        const { userId } = body ? JSON.parse(body) : {} as any
        if (!userId) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "userId is required" }))
          return
        }
        getOrCreateSession(cfg, userId).then((entry) => {
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

    // ── Window management APIs ───────────────────────────────────────────
    // GET /api/windows?userId=xxx — list all windows
    if (req.method === "GET" && req.url?.startsWith("/api/windows")) {
      const url = new URL(req.url, `http://localhost:${cfg.port}`)
      const userId = url.searchParams.get("userId")
      if (!userId) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "userId is required" }))
        return
      }
      getAllWindows(cfg, userId).then((entries) => {
        const rows = db.findMany("user_session", { filter: { op: "eq", field: "user_id", value: userId } })
        const defaultMap = new Map(rows.map((r: any) => [r.session_id, r.is_default === 1]))
        const list = entries.map((e) => ({
          id: e.id,
          directory: e.directory,
          createdAt: e.createdAt,
          isDefault: defaultMap.get(e.id) ?? false,
        }))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(list))
      }).catch((err: any) => {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      })
      return
    }

    // POST /api/windows — create new window
    if (req.method === "POST" && req.url === "/api/windows") {
      (async () => {
        let body = ""
        for await (const chunk of req) body += chunk
        const { userId } = body ? JSON.parse(body) : {} as any
        if (!userId) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "userId is required" }))
          return
        }
        createNewWindow(cfg, userId, false).then((entry) => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: entry.id, directory: entry.directory, isDefault: false }))
        }).catch((err: any) => {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: err.message }))
        })
      })()
      return
    }

    // DELETE /api/windows/:id — delete non-default window
    const windowDeleteMatch = req.url?.match(/^\/api\/windows\/([^/?]+)$/)
    if (req.method === "DELETE" && windowDeleteMatch) {
      const ok = deleteWindow(windowDeleteMatch[1])
      if (ok) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Cannot delete default window or window not found" }))
      }
      return
    }

    // GET /api/sessions/:id
    const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/?]+)(?:\/([a-z]+))?/)
    if (req.method === "GET" && sessionMatch) {
      const session = getSession(sessionMatch[1])
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Session not found" }))
        return
      }

      const sub = sessionMatch[2]
      const url = new URL(req.url!, `http://localhost:${cfg.port}`)

      // GET /api/sessions/:id/state — polling endpoint for topLevel + changes
      if (sub === "state") {
        const dir = session.directory
        const [topLevel, changes] = await Promise.all([
          dir ? listDir(dir) : Promise.resolve([]),
          dir ? getGitChanges(dir) : Promise.resolve([]),
        ])
        const hasPreview = previewSessionId === session.id && previewTarget
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ directory: dir, topLevel, changes, previewPort: hasPreview ? cfg.previewPort : null }))
        return
      }

      // GET /api/sessions/:id/ls?path=xxx — lazy directory listing
      if (sub === "ls") {
        const subPath = url.searchParams.get("path") || ""
        const dir = session.directory
        if (!dir) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ entries: [] }))
          return
        }
        const target = path.resolve(dir, subPath)
        if (!target.startsWith(path.resolve(dir))) {
          res.writeHead(403, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Forbidden" }))
          return
        }
        const entries = await listDir(target)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ entries }))
        return
      }

      // GET /api/sessions/:id/file?path=xxx — read file content
      if (sub === "file") {
        const filePath = url.searchParams.get("path") || ""
        const dir = session.directory
        if (!dir) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ content: null, error: "No directory" }))
          return
        }
        const target = path.resolve(dir, filePath)
        if (!target.startsWith(path.resolve(dir))) {
          res.writeHead(403, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Forbidden" }))
          return
        }
        try {
          const content = await fsPromises.readFile(target, "utf-8")
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ content }))
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ content: null, error: "读取失败" }))
        }
        return
      }

      // GET /api/sessions/:id/diff?path=xxx — changed line numbers for a file
      if (sub === "diff") {
        const filePath = url.searchParams.get("path") || ""
        const dir = session.directory
        if (!dir) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ added: [], removed: [] }))
          return
        }
        try {
          const added: number[] = []
          const removed: number[] = []
          // Try tracked diff first, then fall back to untracked (new file)
          let result = await gitProvider.run(
            ["diff", "--unified=0", "--", filePath],
            { cwd: dir },
          )
          if (result.exitCode !== 0 || !result.text().trim()) {
            // Untracked or staged-only — try diff against empty tree
            result = await gitProvider.run(
              ["diff", "--unified=0", "--cached", "--", filePath],
              { cwd: dir },
            )
          }
          const diffText = result.text()
          // Parse unified diff hunk headers: @@ -old,count +new,count @@
          const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
          let m: RegExpExecArray | null
          while ((m = hunkRe.exec(diffText))) {
            const oldStart = parseInt(m[1], 10)
            const oldCount = parseInt(m[2] ?? "1", 10)
            const newStart = parseInt(m[3], 10)
            const newCount = parseInt(m[4] ?? "1", 10)
            for (let i = 0; i < oldCount; i++) removed.push(oldStart + i)
            for (let i = 0; i < newCount; i++) added.push(newStart + i)
          }
          // For completely untracked files, mark all lines as added
          if (!diffText.trim()) {
            try {
              const target = path.resolve(dir, filePath)
              if (target.startsWith(path.resolve(dir))) {
                const content = await fsPromises.readFile(target, "utf-8")
                const lineCount = content.split("\n").length
                for (let i = 1; i <= lineCount; i++) added.push(i)
              }
            } catch { /* ignore */ }
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ added, removed }))
        } catch {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ added: [], removed: [] }))
        }
        return
      }

      // GET /api/sessions/:id (no sub-route) — basic session info
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
      const url = new URL(req.url, `http://localhost:${cfg.port}`)
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
      res.end(adminHTML(cfg))
      return
    }

    // ── Static files from app/dist ──
    if (req.method === "GET") {
      if (serveStatic(cfg, req, res)) return
      if (serveAppIndex(cfg, res)) return
    }

    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "Not found" }))
  })
  return server
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function startServer() {
  const cfg = loadConfig()
  process.on("uncaughtException", (err) => {
    console.error("⚠  Uncaught exception:", err.message)
  })
  process.on("unhandledRejection", (reason) => {
    console.error("⚠  Unhandled rejection:", reason instanceof Error ? reason.message : reason)
  })
  const previewServer = createPreviewServer(cfg)
  const server = createMainServer(cfg)
  console.log("🚀  Starting @any-code/server…")

  // ── Initialise shared storage ──
  sharedStorage = new SqlJsStorage(DB_PATH)
  const migrations = Database.getMigrations()
  db = await sharedStorage.connect(migrations)

  // Server-specific table: maps user IDs to their windows/sessions.
  // Migrate from old schema (user_id PK, no is_default) to new schema
  // (session_id PK, is_default) — preserves all existing data.
  const cols = sharedStorage.query(`PRAGMA table_info("user_session")`)
  if (cols.length > 0) {
    const hasIsDefault = cols.some((c: any) => c.name === "is_default")
    // pk field in PRAGMA table_info is >0 for PK columns
    const pkCol = cols.find((c: any) => c.pk === 1)
    const needsPkMigration = pkCol && pkCol.name === "user_id"

    if (!hasIsDefault || needsPkMigration) {
      console.log("🔄  Migrating user_session table…")
      // Step 1: add is_default column if missing (needed before copying data)
      if (!hasIsDefault) {
        sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "is_default" INTEGER NOT NULL DEFAULT 0`)
        // Mark all existing sessions as default
        sharedStorage.exec(`UPDATE "user_session" SET "is_default" = 1`)
      }
      // Step 2: rebuild table to change PK from user_id to session_id
      if (needsPkMigration) {
        sharedStorage.exec(`CREATE TABLE "user_session_new" (
          "session_id"   TEXT PRIMARY KEY,
          "user_id"      TEXT NOT NULL,
          "directory"    TEXT NOT NULL DEFAULT '',
          "time_created" INTEGER NOT NULL,
          "is_default"   INTEGER NOT NULL DEFAULT 0
        )`)
        sharedStorage.exec(`INSERT INTO "user_session_new" SELECT "session_id","user_id","directory","time_created","is_default" FROM "user_session"`)
        sharedStorage.exec(`DROP TABLE "user_session"`)
        sharedStorage.exec(`ALTER TABLE "user_session_new" RENAME TO "user_session"`)
      }
      console.log("✅  user_session migration complete")
    }
  } else {
    // Table doesn't exist — create fresh
    sharedStorage.exec(`
      CREATE TABLE IF NOT EXISTS "user_session" (
        "session_id"   TEXT PRIMARY KEY,
        "user_id"      TEXT NOT NULL,
        "directory"    TEXT NOT NULL DEFAULT '',
        "time_created" INTEGER NOT NULL,
        "is_default"   INTEGER NOT NULL DEFAULT 0
      )
    `)
  }

  const appDistExists = fs.existsSync(cfg.appDist)

  // ── Stale polling client cleanup (every 30s) ──
  setInterval(() => {
    const now = Date.now()
    for (const [id, client] of pollingClients) {
      if (now - client.lastActivity > 60000) {
        console.log(`🧹  Cleaning up stale poll client (channel=${id})`)
        client.close()
        removeClient(client.sessionId, client)
        pollingClients.delete(id)
      }
    }
  }, 30000)

  // ── WebSocket server on same HTTP server ──
  const wss = new WebSocketServer({ server })
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://localhost:${cfg.port}`)
    const sessionId = url.searchParams.get("sessionId")
    if (!sessionId || !getSession(sessionId)) {
      ws.close(4001, "Invalid session")
      return
    }

    // Terminal WebSocket — separate lifecycle from state clients
    if (url.pathname === "/terminal") {
      handleTerminalWs(ws, sessionId)
      return
    }

    const clients = getSessionClients(sessionId)
    clients.add(ws as ClientLike)
    console.log(`🔌  WS client connected to session ${sessionId} (${clients.size} total)`)

    // Send current state to this client only (no broadcast)
    sendStateTo(cfg, sessionId, ws as ClientLike)

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleClientMessage(sessionId, ws as ClientLike, msg).catch(() => { })
      } catch { /* ignore malformed */ }
    })

    ws.on("close", () => {
      removeClient(sessionId, ws as ClientLike)
    })
  })

  const HOST = process.env.HOST ?? "0.0.0.0"

  previewServer.listen(cfg.previewPort, HOST, () => {
    console.log(`👁  Preview proxy: http://${HOST}:${cfg.previewPort}`)
  })

  server.listen(cfg.port, HOST, () => {
    console.log(`🌐  http://${HOST}:${cfg.port}`)
    console.log(`🤖  Provider: ${cfg.provider} / ${cfg.model}`)
    console.log(`🖥  Admin: http://${HOST}:${cfg.port}/admin`)
    if (appDistExists) {
      console.log(`📱  App: http://${HOST}:${cfg.port}`)
    } else {
      console.log(`⚠  App dist not found at ${cfg.appDist} — run 'pnpm --filter @any-code/app build' first`)
    }
    console.log(`📋  Sessions: POST /api/sessions to create`)
    console.log(`🔌  WebSocket: ws://${HOST}:${cfg.port}?sessionId=xxx`)
  })
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider }
