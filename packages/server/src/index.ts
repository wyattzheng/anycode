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
 *   TLS_CERT    — Path to TLS certificate file (optional, enables HTTPS)
 *   TLS_KEY     — Path to TLS private key file  (optional, enables HTTPS)
 */

import http from "http"
import https from "https"
import { fileURLToPath } from "url"
import path from "path"
import os from "os"
import fs from "fs"
import fsPromises from "fs/promises"
import { execFile, spawn as cpSpawn } from "child_process"
import { CodeAgent, Database, type NoSqlDb, type TerminalProvider, type PreviewProvider, SetWorkingDirectoryTool, TerminalWriteTool, TerminalReadTool, SetPreviewUrlTool } from "@any-code/agent"
import { WebSocketServer, WebSocket as WS } from "ws"
// @ts-expect-error — @lydell/node-pty has types but exports config doesn't expose them
import * as pty from "@lydell/node-pty"
import { SqlJsStorage, NodeFS, NodeSearchProvider } from "@any-code/utils"
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar"
import { createChatAgent, type IChatAgent } from "./chat-agent"

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
  tlsCert?: string
  tlsKey?: string
  /** Agent backend: "anycode" (default), "claudecode", or "codex" */
  agent: string
}

function loadConfig(): ServerConfig {
  let userSettings: Record<string, any> = {}
  try {
    userSettings = JSON.parse(fs.readFileSync(path.join(ANYCODE_DIR, "settings.json"), "utf-8"))
  } catch { }
  const agent = process.env.AGENT ?? userSettings.AGENT ?? "anycode"
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
  const tlsCert = process.env.TLS_CERT ?? userSettings.TLS_CERT ?? undefined
  const tlsKey = process.env.TLS_KEY ?? userSettings.TLS_KEY ?? undefined
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    console.error("❌  Both TLS_CERT and TLS_KEY must be set together")
    process.exit(1)
  }
  return { provider, model, apiKey, baseUrl, port, previewPort, appDist, userSettings, tlsCert, tlsKey, agent }
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
  chatAgent: IChatAgent
  directory: string  // empty = no project directory set yet
  title: string      // session title (populated when agent generates it)
  createdAt: number
  state: SessionStateModel
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
    extraTools: [
      SetWorkingDirectoryTool,
      TerminalWriteTool,
      TerminalReadTool,
      SetPreviewUrlTool,
    ],
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

/** Create a ChatAgentConfig for the given session context */
function createChatAgentConfig(cfg: ServerConfig, directory: string, sessionId?: string, terminal?: TerminalProvider, preview?: PreviewProvider) {
  return {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    terminal,
    preview,
    codeAgentOptions: createAgentConfig(cfg, directory, sessionId, terminal, preview),
  }
}

/** Wire up agent events and register in sessions map. */
function registerSession(cfg: ServerConfig, id: string, chatAgent: IChatAgent, directory: string, createdAt: number): SessionEntry {
  const entry: SessionEntry = {
    id,
    chatAgent,
    directory,
    createdAt,
    title: "",
    state: new SessionStateModel(id, cfg)
  }
  sessions.set(id, entry)

  // Kick off initial state compute
  entry.state.updateFileSystem(directory)

  // Listen for directory.set events from the agent
  chatAgent.on("directory.set", (data: any) => {
    const dir = data.directory
    entry.directory = dir
    try { chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
    // Persist directory back to user_session mapping
    db.update("user_session", { op: "eq", field: "session_id", value: id }, { directory: dir })
    console.log(`📂  Session ${id} directory set to: ${dir}`)
    entry.state.updateFileSystem(dir)
    watchDirectory(cfg, id, dir)
    // Notify all clients that window list changed (directory updated)
    broadcastAll({ type: "windows.updated" })
  })

  // Listen for session title changes to push window list updates
  chatAgent.on("session.updated", (data: any) => {
    const title = data?.info?.title
    if (title && title !== entry.title) {
      entry.title = title
      broadcastAll({ type: "windows.updated" })
    }
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

  const chatAgent = createChatAgent(cfg.agent, createChatAgentConfig(cfg, dir, sessionId, tp, pp))

  const entry = registerSession(cfg, sessionId, chatAgent, dir, row.time_created as number)
  if (dir) {
    try { chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
    watchDirectory(cfg, sessionId, dir)
  }
  console.log(`♻️  Session ${sessionId} resumed`)
  return entry
}

/**
 * Create a brand new session/window.
 */
async function createNewWindow(cfg: ServerConfig, isDefault = false): Promise<SessionEntry> {
  const tempId = `temp-${Date.now()}`
  const tp = getOrCreateTerminalProvider(tempId)
  const pp = getOrCreatePreviewProvider(cfg, tempId)

  const chatAgent = createChatAgent(cfg.agent, createChatAgentConfig(cfg, "", undefined, tp, pp))
  await chatAgent.ensureInit()

  const sessionId = chatAgent.sessionId
  const now = Date.now()
  terminalProviders.delete(tempId)
  terminalProviders.set(sessionId, tp)
  previewProviders.delete(tempId)
  previewProviders.set(sessionId, pp)
    ; (tp as any).sessionId = sessionId
    ; (pp as any).sessionId = sessionId
  const entry = registerSession(cfg, sessionId, chatAgent, "", now)

  db.insert("user_session", {
    session_id: sessionId,
    directory: "",
    time_created: now,
    is_default: isDefault ? 1 : 0,
  })

  console.log(`✅  Window ${sessionId} created${isDefault ? " (default)" : ""}`)
  return entry
}

/**
 * Get or create the default window.
 * Returns the default session; creates one if none exists.
 */
async function getOrCreateSession(cfg: ServerConfig): Promise<SessionEntry> {
  const rows = db.findMany("user_session", {})
  const defaultRow = rows.find((r: any) => r.is_default === 1) || rows[0]

  if (defaultRow) {
    if (defaultRow.is_default !== 1) {
      db.update("user_session", { op: "eq", field: "session_id", value: defaultRow.session_id }, { is_default: 1 })
    }
    return resumeSession(cfg, defaultRow)
  }

  return createNewWindow(cfg, true)
}

/**
 * Get all windows. Resumes any that aren't in memory.
 */
async function getAllWindows(cfg: ServerConfig): Promise<SessionEntry[]> {
  const rows = db.findMany("user_session", {})
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
    // Find the actual git root — may differ from `dir` if project is inside a parent repo
    const rootResult = await gitProvider.run(["rev-parse", "--show-toplevel"], { cwd: dir })
    const gitRoot = rootResult.exitCode === 0 ? rootResult.text().trim() : ""
    if (!gitRoot) return []

    const result = await gitProvider.run(["status", "--porcelain", "-uall"], { cwd: dir })
    if (result.exitCode !== 0) return []
    const text = result.text()
    if (!text.trim()) return []

    // git status paths are relative to gitRoot
    // If gitRoot !== dir, we need to filter & re-relativize paths
    const needsFilter = path.resolve(gitRoot) !== path.resolve(dir)
    const relPrefix = needsFilter ? path.relative(gitRoot, dir) + "/" : ""

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
      .filter(({ file }) => !needsFilter || file.startsWith(relPrefix))
      .map(({ file, status }) => ({
        file: needsFilter ? file.slice(relPrefix.length) : file,
        status,
      }))
  } catch {
    return []
  }
}

// ── Channel abstraction ───────────────────────────────────────────────────

/** Minimal interface for WebSocket clients */
interface ClientLike {
  readyState: number
  send(data: string): void
}

// Track WebSocket clients per session
const sessionClients = new Map<string, Set<ClientLike>>()

// Track active chat abort functions per session
const sessionChatAbort = new Map<string, () => void>()

// Cached last-pushed state JSON per session — used for diffing + replay to new clients
const statePushTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleStatePush(cfg: ServerConfig, sessionId: string, delayMs = 300) {
  const existing = statePushTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    statePushTimers.delete(sessionId)
    getSession(sessionId)?.state.updateFileSystem()
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

/** Broadcast to ALL connected WebSocket clients across all sessions */
function broadcastAll(data: Record<string, unknown>) {
  const json = JSON.stringify(data)
  for (const clients of sessionClients.values()) {
    for (const c of clients) {
      if (c.readyState === WS.OPEN) c.send(json)
    }
  }
}



/** Handle incoming client message from WebSocket */
async function handleClientMessage(sessionId: string, client: ClientLike, msg: any) {
  // Application-level heartbeat: reply with pong immediately
  if (msg.type === "ping") {
    client.send(JSON.stringify({ type: "pong" }))
    return
  }

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
    sessionChatAbort.set(sessionId, () => {
      aborted = true
      session.chatAgent.abort?.()
    })

    session.state.setChatBusy(true)

    try {
      for await (const event of session.chatAgent.chat(effectiveMessage)) {
        if (aborted) break
        broadcast(sessionId, { type: "chat.event", event })
      }
    } catch (err: any) {
      broadcast(sessionId, { type: "chat.event", event: { type: "error", error: err.message } })
    }

    sessionChatAbort.delete(sessionId)
    session.state.setChatBusy(false)
    broadcast(sessionId, { type: "chat.done" })
  }

  if (msg.type === "chat.stop") {
    sessionChatAbort.get(sessionId)?.()
  }
}

// ── Directory watcher (chokidar) ─────────────────────────────────────────

const watchers = new Map<string, ChokidarWatcher>()

function watchDirectory(cfg: ServerConfig, sessionId: string, dir: string) {
  // Clean up existing watcher for this session
  const existing = watchers.get(sessionId)
  if (existing) {
    existing.close()
    watchers.delete(sessionId)
  }

  // If dir is empty (cleared), just stop watching
  if (!dir) return

  const debouncedPush = () => {
    scheduleStatePush(cfg, sessionId, 500)
  }

  const watcher = chokidarWatch(dir, {
    ignored: /(^|[\/\\])(\.git|node_modules)([\/\\]|$)/,
    ignoreInitial: true,
    // Always use polling since native watchers often fail in Docker bind mounts
    usePolling: true,
    interval: 3000,
  })

  watcher.on("all", () => debouncedPush())
  watcher.on("error", (err) => console.error(`❌  chokidar error for ${dir}:`, err))
  watchers.set(sessionId, watcher)
  console.log(`👁  Watching directory: ${dir}`)
}

export class SessionStateModel {
  sessionId: string
  cfg: ServerConfig
  directory: string = ""
  topLevel: any[] = []
  changes: any[] = []
  previewPort: number | null = null
  chatBusy: boolean = false

  private _isComputing = false
  private _needsCompute = false

  constructor(sessionId: string, cfg: ServerConfig) {
    this.sessionId = sessionId
    this.cfg = cfg
  }

  async updateFileSystem(dir?: string) {
    if (dir !== undefined && this.directory !== dir) {
      this.directory = dir
      this.topLevel = []
      this.changes = []
    }

    // Calculate expected port here during file system polls as well
    const expectedPort = (previewSessionId === this.sessionId && previewTarget) ? this.cfg.previewPort : null
    if (this.previewPort !== expectedPort) {
      this.previewPort = expectedPort
    }

    if (this._isComputing) {
      this._needsCompute = true
      return
    }

    this._isComputing = true
    try {
      do {
        this._needsCompute = false
        const currentDir = this.directory
        const [topLevel, changes] = await Promise.all([
          currentDir ? listDir(currentDir) : Promise.resolve([]),
          currentDir ? getGitChanges(currentDir) : Promise.resolve([]),
        ])

        const newTopJson = JSON.stringify(topLevel)
        const newChangesJson = JSON.stringify(changes)
        const oldTopJson = JSON.stringify(this.topLevel)
        const oldChangesJson = JSON.stringify(this.changes)

        if (newTopJson !== oldTopJson || newChangesJson !== oldChangesJson) {
          this.topLevel = topLevel
          this.changes = changes
          this.notify()
        }
      } while (this._needsCompute)
    } catch (err) {
      console.error(`❌ SessionStateModel compute error:`, err)
    } finally {
      this._isComputing = false
    }
  }

  setPreviewPort(port: number | null) {
    if (this.previewPort !== port) {
      this.previewPort = port
      this.notify()
    }
  }

  setChatBusy(busy: boolean) {
    if (this.chatBusy !== busy) {
      this.chatBusy = busy
      this.notify()
    }
  }

  toJSON() {
    return {
      type: "state",
      directory: this.directory,
      topLevel: this.topLevel,
      changes: this.changes,
      previewPort: this.previewPort,
      chatBusy: this.chatBusy,
    }
  }

  notify() {
    const json = JSON.stringify(this.toJSON())
    const clients = getSessionClients(this.sessionId)
    console.log(`📤  SessionStateModel(${this.sessionId}): dir="${this.directory}", topLevel=${this.topLevel.length} entries, changes=${this.changes.length}, previewPort=${this.previewPort}, clients=${clients.size}`)
    for (const c of clients) {
      if (c.readyState === WS.OPEN) c.send(json)
    }
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
 * TerminalStateModel — manages terminal state and client sync.
 *
 * Follows the same pattern as SessionStateModel:
 *  - Holds the state (rawBuffer, alive)
 *  - notify(): broadcast incremental updates to all clients
 *  - syncClient(): full-state replay for newly connected clients
 *  - handleClient(): register WS + lifecycle management
 */
const MAX_RAW_BUFFER = 200

class TerminalStateModel {
  private rawBuffer: string[] = []
  private alive = false
  private wsClients = new Set<WS>()
  private syncedClients = new WeakSet<WS>()

  // Callbacks set by NodeTerminalProvider for user input
  onInput: ((data: string) => void) | null = null
  onResize: ((cols: number, rows: number) => void) | null = null

  /** Update alive state and notify clients */
  setAlive(alive: boolean): void {
    this.alive = alive
    this.notify({ type: alive ? "terminal.ready" : "terminal.none" })
  }

  /** Append raw output data — cache and push to clients */
  pushOutput(data: string): void {
    this.rawBuffer.push(data)
    if (this.rawBuffer.length > MAX_RAW_BUFFER) {
      this.rawBuffer.splice(0, this.rawBuffer.length - MAX_RAW_BUFFER)
    }
    this.notify({ type: "terminal.output", data })
  }

  /** Push a terminal exited event */
  pushExited(exitCode: number): void {
    this.notify({ type: "terminal.exited", exitCode })
  }

  /** Clear all buffered state */
  reset(): void {
    this.rawBuffer = []
    this.syncedClients = new WeakSet()
  }

  /** Broadcast a message to all connected clients */
  private notify(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg)
    for (const ws of this.wsClients) {
      if (ws.readyState === WS.OPEN) ws.send(json)
    }
  }

  /**
   * Full-state sync for a single client.
   * Called after the client's first resize so the PTY size matches.
   */
  private syncClient(ws: WS): void {
    if (this.syncedClients.has(ws)) return
    this.syncedClients.add(ws)
    for (const chunk of this.rawBuffer) {
      if (ws.readyState === WS.OPEN) {
        ws.send(JSON.stringify({ type: "terminal.output", data: chunk }))
      }
    }
  }

  /**
   * Register a new WebSocket client and manage its lifecycle.
   *  1. Send current state (ready / none)
   *  2. First resize → full sync (replay buffer)
   *  3. After that, live updates via notify()
   */
  handleClient(ws: WS): void {
    this.wsClients.add(ws)

    // 1. Current state
    ws.send(JSON.stringify({ type: this.alive ? "terminal.ready" : "terminal.none" }))

    // 2. Messages
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "terminal.input") {
          this.onInput?.(msg.data)
        } else if (msg.type === "terminal.resize") {
          this.onResize?.(msg.cols, msg.rows)
          this.syncClient(ws)
        }
      } catch { /* ignore */ }
    })

    // 3. Cleanup
    ws.on("close", () => { this.wsClients.delete(ws) })
  }
}

/**
 * NodeTerminalProvider — per-session PTY process manager.
 *
 * Manages PTY lifecycle (create/destroy/write/read/resize).
 * Feeds output to TerminalStateModel for client sync.
 */
class NodeTerminalProvider implements TerminalProvider {
  private proc: pty.IPty | null = null
  private lines: string[] = []
  private currentLine = ""
  private sessionId: string
  readonly model: TerminalStateModel

  constructor(sessionId: string) {
    this.sessionId = sessionId
    this.model = new TerminalStateModel()
    this.model.onInput = (data) => this.proc?.write(data)
    this.model.onResize = (cols, rows) => this.resize(cols, rows)
  }

  exists(): boolean { return this.proc !== null }

  create(): void {
    if (this.proc) throw new Error("Terminal already exists. Destroy it first.")
    const session = getSession(this.sessionId)
    const cwd = session?.directory || os.homedir()
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash")

    if (!fs.existsSync(cwd)) {
      throw new Error(`Terminal cwd does not exist: ${cwd}`)
    }

    console.log(`🖥  Terminal creating: shell=${shell}, cwd=${cwd}, sessionId=${this.sessionId}`)
    this.lines = []
    this.currentLine = ""
    this.model.reset()

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    env.PROMPT_EOL_MARK = ""
    env.CLICOLOR = "1"
    env.CLICOLOR_FORCE = "1"
    env.LSCOLORS = "GxFxCxDxBxegedabagaced"

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    })

    console.log(`🖥  Terminal created for session ${this.sessionId} (pid ${proc.pid}, cwd ${cwd})`)

    proc.onData((data: string) => {
      this.appendToBuffer(data)
      this.model.pushOutput(data)
    })

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`🖥  Terminal exited for session ${this.sessionId} (code ${exitCode})`)
      this.proc = null
      this.model.pushExited(exitCode)
      this.model.setAlive(false)
    })

    this.proc = proc
    this.model.setAlive(true)
  }

  destroy(): void {
    if (!this.proc) throw new Error("No terminal exists.")
    console.log(`🖥  Terminal destroyed for session ${this.sessionId}`)
    this.proc.kill()
    this.proc = null
    this.lines = []
    this.currentLine = ""
    this.model.reset()
    this.model.setAlive(false)
  }

  write(data: string): void {
    if (!this.proc) throw new Error("No terminal exists.")
    this.proc.write(data)
  }

  read(lineCount: number): string {
    if (!this.proc) throw new Error("No terminal exists.")
    const allLines = this.currentLine
      ? [...this.lines, this.currentLine]
      : [...this.lines]
    const start = Math.max(0, allLines.length - lineCount)
    return allLines.slice(start).join("\n")
  }

  resize(cols: number, rows: number): void {
    if (this.proc && cols > 0 && rows > 0) {
      this.proc.resize(cols, rows)
    }
  }

  private appendToBuffer(data: string) {
    const clean = stripAnsi(data)
    const lines = clean.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const segment = lines[i]
      if (i === 0) {
        this.handleCR(segment)
      } else {
        this.lines.push(this.currentLine)
        this.currentLine = ""
        this.handleCR(segment)
        if (this.lines.length > MAX_BUFFER_LINES) {
          this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES)
        }
      }
    }
  }

  private handleCR(segment: string) {
    const crParts = segment.split("\r")
    if (crParts.length === 1) {
      this.currentLine += segment
    } else {
      for (const part of crParts) {
        if (part === "") continue
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
  getOrCreateTerminalProvider(sessionId).model.handleClient(ws)
}




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
    // Normalize localhost → 127.0.0.1 to avoid IPv4/IPv6 mismatch (Vite 5+ may bind IPv6)
    try {
      const u = new URL(forwardedLocalUrl)
      if (u.hostname === "localhost") u.hostname = "127.0.0.1"
      previewTarget = u.origin
    } catch {
      previewTarget = forwardedLocalUrl.replace(/\/+$/, "")
    }
    previewSessionId = this.sessionId
    console.log(`🔗  Preview proxy: :${this.cfg.previewPort} → ${previewTarget} (session ${this.sessionId})`)

    // Let the reactive state model handle the broadcast natively
    getSession(this.sessionId)?.state.setPreviewPort(this.cfg.previewPort)
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
  const previewServer = createServer(cfg, (req, res) => {
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
    const html = fs.readFileSync(indexPath, "utf-8")
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
    return true
  }
  return false
}

/** Create an http or https server depending on TLS config */
function createServer(cfg: ServerConfig, handler: http.RequestListener): http.Server {
  if (cfg.tlsCert && cfg.tlsKey) {
    return https.createServer({
      cert: fs.readFileSync(cfg.tlsCert),
      key: fs.readFileSync(cfg.tlsKey),
    }, handler)
  }
  return http.createServer(handler)
}

// ── HTTP Server ────────────────────────────────────────────────────────────

function createMainServer(cfg: ServerConfig): http.Server {
  const server = createServer(cfg, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    // ── Static files first — never blocked by async API operations ──
    if (req.method === "GET" && !req.url?.startsWith("/api/") && !req.url?.startsWith("/admin")) {
      if (serveStatic(cfg, req, res)) return
      if (serveAppIndex(cfg, res)) return
    }

    // ── Session management ──
    if (req.method === "POST" && req.url === "/api/sessions") {
      getOrCreateSession(cfg).then((entry) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: entry.id, directory: entry.directory }))
      }).catch((err: any) => {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      })
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
    // GET /api/windows — list all windows
    if (req.method === "GET" && req.url?.startsWith("/api/windows")) {
      getAllWindows(cfg).then(async (entries) => {
        const rows = db.findMany("user_session", {})
        const defaultMap = new Map(rows.map((r: any) => [r.session_id, r.is_default === 1]))
        const list = entries.map((e) => ({
          id: e.id,
          title: e.title || "",
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
      createNewWindow(cfg, false).then((entry) => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ id: entry.id, directory: entry.directory, isDefault: false }))
      }).catch((err: any) => {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: err.message }))
      })
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
        stats: s.chatAgent.getStats(),
        sessionId: s.chatAgent.sessionId,
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
      session.chatAgent.getSessionMessages({ limit: 30 }).then((messages: any) => {
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
    const hasUserId = cols.some((c: any) => c.name === "user_id")
    const pkCol = cols.find((c: any) => c.pk === 1)
    const needsPkMigration = pkCol && pkCol.name === "user_id"
    const needsMigration = !hasIsDefault || needsPkMigration || hasUserId

    if (needsMigration) {
      console.log("🔄  Migrating user_session table…")
      // Step 1: add is_default column if missing (needed before copying data)
      if (!hasIsDefault) {
        sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "is_default" INTEGER NOT NULL DEFAULT 0`)
        sharedStorage.exec(`UPDATE "user_session" SET "is_default" = 1`)
      }
      // Step 2: rebuild table — drop user_id column and fix PK
      if (needsPkMigration || hasUserId) {
        sharedStorage.exec(`CREATE TABLE "user_session_new" (
          "session_id"   TEXT PRIMARY KEY,
          "directory"    TEXT NOT NULL DEFAULT '',
          "time_created" INTEGER NOT NULL,
          "is_default"   INTEGER NOT NULL DEFAULT 0
        )`)
        sharedStorage.exec(`INSERT INTO "user_session_new" SELECT "session_id","directory","time_created","is_default" FROM "user_session"`)
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
        "directory"    TEXT NOT NULL DEFAULT '',
        "time_created" INTEGER NOT NULL,
        "is_default"   INTEGER NOT NULL DEFAULT 0
      )
    `)
  }

  const appDistExists = fs.existsSync(cfg.appDist)



  // ── WebSocket server on same HTTP server ──
  const wss = new WebSocketServer({ server })

  // Heartbeat: ping clients every 30s, terminate dead connections
  const WS_PING_INTERVAL = 30_000
  const aliveSet = new WeakSet<WS>()
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSet.has(ws)) {
        ws.terminate()
        continue
      }
      aliveSet.delete(ws)
      ws.ping()
    }
  }, WS_PING_INTERVAL)
  wss.on("close", () => clearInterval(pingTimer))

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", `http://localhost:${cfg.port}`)
    const sessionId = url.searchParams.get("sessionId")
    if (!sessionId || !getSession(sessionId)) {
      ws.close(4001, "Invalid session")
      return
    }

    // Mark alive on connect and on each pong
    aliveSet.add(ws)
    ws.on("pong", () => aliveSet.add(ws))

    // Terminal WebSocket — separate lifecycle from state clients
    if (url.pathname === "/terminal") {
      handleTerminalWs(ws, sessionId)
      return
    }

    const clients = getSessionClients(sessionId)
    clients.add(ws as ClientLike)
    console.log(`🔌  WS client connected to session ${sessionId} (${clients.size} total)`)

    // Send current state to this client only (no broadcast)
    const sessionModel = getSession(sessionId)?.state
    if (sessionModel) {
      ws.send(JSON.stringify(sessionModel.toJSON()))
    }

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

  const proto = cfg.tlsCert ? "https" : "http"
  const wsProto = cfg.tlsCert ? "wss" : "ws"

  previewServer.listen(cfg.previewPort, HOST, () => {
    console.log(`👁  Preview proxy: ${proto}://${HOST}:${cfg.previewPort}`)
  })

  server.listen(cfg.port, HOST, () => {
    console.log(`🌐  ${proto}://${HOST}:${cfg.port}`)
    console.log(`🤖  Provider: ${cfg.provider} / ${cfg.model}`)
    console.log(`🖥  Admin: ${proto}://${HOST}:${cfg.port}/admin`)
    if (appDistExists) {
      console.log(`📱  App: ${proto}://${HOST}:${cfg.port}`)
    } else {
      console.log(`⚠  App dist not found at ${cfg.appDist} — run 'pnpm --filter @any-code/app build' first`)
    }
    console.log(`📋  Sessions: POST /api/sessions to create`)
    console.log(`🔌  WebSocket: ${wsProto}://${HOST}:${cfg.port}?sessionId=xxx`)
    if (cfg.tlsCert) console.log(`🔒  TLS enabled`)
  })
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider };
export type { VirtualFileSystem, StorageProvider, Migration } from "@any-code/utils"
