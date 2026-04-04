/**
 * @any-code/server — API server for CodeAgent
 *
 * Starts a lightweight HTTP server that:
 *   1. Chat is handled via WebSocket (broadcast to all clients)
 *   2. Frontend is served separately by the app package
 *
 * Runtime config:
 *   ~/.anycode/settings.json
 *     - current account: AGENT / PROVIDER / MODEL / API_KEY / BASE_URL
 *
 * Environment variables:
 *   PORT        — HTTP port         (default: 3210)
 *   TLS_CERT    — Path to TLS certificate file (optional, enables HTTPS)
 *   TLS_KEY     — Path to TLS private key file  (optional, enables HTTPS)
 */

import http from "http"
import xtermHeadless from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import https from "https"
import { fileURLToPath } from "url"
import path from "path"
import os from "os"
import fs from "fs"
import fsPromises from "fs/promises"
import { execFile, spawn as cpSpawn } from "child_process"
import { CodeAgent, type NoSqlDb, type TerminalProvider, type PreviewProvider } from "@any-code/agent"
import { SetWorkingDirectoryTool } from "./tool-set-directory"
import { TerminalTool } from "./tool-terminal-write"
import { SetPreviewUrlTool } from "./tool-set-preview-url"
import { WebSocketServer, WebSocket as WS } from "ws"
// @ts-expect-error — @lydell/node-pty has types but exports config doesn't expose them
import * as pty from "@lydell/node-pty"
import { SqlJsStorage, NodeFS, NodeSearchProvider } from "@any-code/utils"
import { DEFAULT_MODEL, SettingsModel, SettingsStore, normalizeString, type UserSettingsFile } from "@any-code/settings"
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar"
import { createChatAgent, type IChatAgent } from "./chat-agent"

// ── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_ANYCODE_DIR = path.join(os.homedir(), ".anycode")
const NO_AGENT_TYPE = "noagent"
const API_ERROR_CODES = {
  SETTINGS_ACCOUNT_INCOMPLETE: "SETTINGS_ACCOUNT_INCOMPLETE",
} as const
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

export interface AnyCodeServerOptions {
  config?: ServerConfig
  anycodeDir?: string
  dbPath?: string
  settingsStore?: SettingsStore
}

function makePaths(anycodeDir: string) {
  const dataPath = path.join(anycodeDir, "data")
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
  agentType: string
  runtimeAgentType: string
  directory: string  // empty = no project directory set yet
  title: string      // session title (populated when agent generates it)
  createdAt: number
  state: SessionStateModel
}

interface NoAgentMessageRecord {
  role: "user" | "assistant"
  text: string
  createdAt: number
}

interface SessionAgentBinding {
  chatAgent: IChatAgent
  agentType: string
  runtimeAgentType: string
}

function createAgentConfig(server: AnyCodeServer, cfg: ServerConfig, directory: string, resumeToken?: string, terminal?: TerminalProvider, preview?: PreviewProvider) {
  return {
    directory: directory,
    fs: new NodeFS(),
    search: new NodeSearchProvider(),
    storage: server.sharedStorage,
    shell: new NodeShellProvider(),
    git: server.gitProvider,
    dataPath: makePaths(server.anycodeDir),
    ...(resumeToken ? { sessionId: resumeToken } : {}),
    ...(terminal ? { terminal } : {}),
    ...(preview ? { preview } : {}),
    tools: [
      SetWorkingDirectoryTool,
      TerminalTool,
      SetPreviewUrlTool,
    ],
    provider: {
      id: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    },
    settings: cfg.userSettings,
    config: {},
    systemPrompt: `You are AnyCode, a voice-driven AI coding assistant running on the user's mobile device.

## Getting Started
When a user starts a new conversation without an active project, your first priority is to help them open or create a project:
- Ask what project they want to work on
- If they provide a path, use set_user_watch_project to open it
- If they want to create a new project, create it first (mkdir + git init), then call set_user_watch_project
- Do NOT start writing code until a project directory has been set via set_user_watch_project

## Guidelines
- Be concise — the user is on mobile, keep responses short
- Prefer action over explanation — execute rather than describe
- When running dev servers or long-lived processes, use the terminal tool and set_preview_url so the user can see results
`,
  }
}

/** Create a ChatAgentConfig for the given session context. */
function createChatAgentConfig(server: AnyCodeServer, cfg: ServerConfig, directory: string, terminal?: TerminalProvider, preview?: PreviewProvider, resumeToken?: string) {
  return {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    terminal,
    preview,
    sessionId: resumeToken,
    codeAgentOptions: createAgentConfig(server, cfg, directory, resumeToken, terminal, preview),
  }
}

function getPreferredAgentType(agentType: string | undefined) {
  return normalizeString(agentType) ?? "anycode"
}

function createNoAgentStore(server: AnyCodeServer, sessionId: string) {
  return {
    async load(limit: number): Promise<NoAgentMessageRecord[]> {
      return getPersistedNoAgentMessages(server, sessionId, limit)
    },
    async append(message: NoAgentMessageRecord) {
      server.db.insert("user_session_message", {
        session_id: sessionId,
        role: message.role,
        text: message.text,
        time_created: message.createdAt,
      })
    },
  }
}

function getPersistedNoAgentMessages(server: AnyCodeServer, sessionId: string, limit: number): NoAgentMessageRecord[] {
  const rows = server.db.findMany("user_session_message", {
    filter: { op: "eq", field: "session_id", value: sessionId },
    orderBy: [{ field: "id", direction: "desc" }],
    limit,
  })
  return rows.reverse().map((row) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    text: typeof row.text === "string" ? row.text : "",
    createdAt: typeof row.time_created === "number" ? row.time_created : Date.now(),
  }))
}

function mergeSessionHistoryMessages(noAgentMessages: NoAgentMessageRecord[], runtimeMessages: any[], limit: number) {
  const normalizedNoAgent = noAgentMessages.map((message, index) => (
    message.role === "user"
      ? {
        id: `noagent-user-${index}`,
        role: "user",
        text: message.text,
        createdAt: message.createdAt,
      }
      : {
        id: `noagent-assistant-${index}`,
        role: "assistant",
        parts: [{ type: "text", content: message.text }],
        createdAt: message.createdAt,
      }
  ))

  return [...normalizedNoAgent, ...(Array.isArray(runtimeMessages) ? runtimeMessages : [])]
    .map((message, index) => ({
      ...message,
      id: typeof message?.id === "string" && message.id ? message.id : `merged-${index}`,
      createdAt: typeof message?.createdAt === "number" ? message.createdAt : index,
    }))
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return String(a.id).localeCompare(String(b.id))
      return a.createdAt - b.createdAt
    })
    .slice(-limit)
}

async function createSessionAgentBinding(
  server: AnyCodeServer,
  cfg: ServerConfig,
  sessionId: string,
  directory: string,
  terminal: TerminalProvider | undefined,
  preview: PreviewProvider | undefined,
  preferredAgentType: string,
  resumeToken?: string,
): Promise<SessionAgentBinding> {
  if (!cfg.apiKey) {
    const chatAgent = await createChatAgent(NO_AGENT_TYPE, {
      ...createChatAgentConfig(server, cfg, directory, terminal, preview),
      name: "No Agent",
      noAgentSessionId: sessionId,
      noAgentStore: createNoAgentStore(server, sessionId),
    } as any)
    await chatAgent.init()
    return {
      chatAgent,
      agentType: preferredAgentType,
      runtimeAgentType: NO_AGENT_TYPE,
    }
  }

  const chatAgent = await createChatAgent(cfg.agent, createChatAgentConfig(server, cfg, directory, terminal, preview, resumeToken))
  await chatAgent.init()
  return {
    chatAgent,
    agentType: cfg.agent,
    runtimeAgentType: cfg.agent,
  }
}

function bindSessionAgentEvents(server: AnyCodeServer, cfg: ServerConfig, entry: SessionEntry, chatAgent: IChatAgent) {
  const id = entry.id
  // Listen for directory.set events from the agent
  chatAgent.on("directory.set", (data: any) => {
    const dir = data.directory
    entry.directory = dir
    try { chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
    // Persist directory back to user_session mapping
    server.db.update("user_session", { op: "eq", field: "session_id", value: id }, { directory: dir })
    console.log(`📂  Session ${id} directory set to: ${dir}`)
    entry.state.updateFileSystem(dir)
    watchDirectory(server, id, dir)
    // Notify all clients that window list changed (directory updated)
    broadcastAll(server, { type: "windows.updated" })
  })

  // Listen for session title changes to push window list updates
  chatAgent.on("session.updated", (data: any) => {
    const title = data?.info?.title
    if (title && title !== entry.title) {
      entry.title = title
      broadcastAll(server, { type: "windows.updated" })
    }
  })

  // Listen for cascade creation to persist cascadeId for session history restoration
  chatAgent.on("cascade.created", (data: any) => {
    persistResumeTokenForWindow(server, id, entry.runtimeAgentType, data?.cascadeId)
  })
}

/** Wire up agent events and register in sessions map. */
function registerSession(
  server: AnyCodeServer,
  cfg: ServerConfig,
  id: string,
  chatAgent: IChatAgent,
  directory: string,
  createdAt: number,
  agentType: string,
  runtimeAgentType: string,
): SessionEntry {
  const entry: SessionEntry = {
    id,
    chatAgent,
    agentType,
    runtimeAgentType,
    directory,
    createdAt,
    title: "",
    state: new SessionStateModel(server, id, cfg)
  }
  server.sessions.set(id, entry)

  // Kick off initial state compute
  entry.state.updateFileSystem(directory)
  bindSessionAgentEvents(server, cfg, entry, chatAgent)

  return entry
}

async function destroyChatAgent(chatAgent: IChatAgent) {
  try { await chatAgent.abort() } catch { /* ignore */ }
  if (typeof chatAgent.destroy === "function") {
    try { await chatAgent.destroy() } catch { /* ignore */ }
  }
}

function getUsableResumeToken(agentType: string, token: string | undefined) {
  if (!token) return undefined
  if (agentType === NO_AGENT_TYPE) return undefined
  if (agentType === "claudecode" && token.startsWith("claude-")) return undefined
  if (agentType === "codex" && token.startsWith("codex-")) return undefined
  return token
}

function tryGetAgentSessionId(chatAgent: IChatAgent) {
  try {
    return chatAgent.sessionId || undefined
  } catch {
    return undefined
  }
}

function persistResumeTokenForWindow(server: AnyCodeServer, windowId: string, agentType: string, token: string | undefined) {
  const resumeToken = getUsableResumeToken(agentType, token)
  if (!resumeToken) return
  server.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { cascade_id: resumeToken })
  console.log(`🔗  Window ${windowId} resume token saved: ${resumeToken}`)
}

function persistAgentTypeForWindow(server: AnyCodeServer, windowId: string, agentType: string) {
  server.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { agent_type: agentType })
}

function getErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined
}

async function replaceSessionAgent(server: AnyCodeServer, cfg: ServerConfig, entry: SessionEntry, keepResumeToken: boolean) {
  const previousAgent = entry.chatAgent
  const row = server.db.findOne("user_session", { op: "eq", field: "session_id", value: entry.id }) as any
  const preferredAgentType = getPreferredAgentType(typeof row?.agent_type === "string" ? row.agent_type : entry.agentType)
  const storedResumeToken = getUsableResumeToken(preferredAgentType, typeof row?.cascade_id === "string" ? row.cascade_id : undefined)
  const liveResumeToken = getUsableResumeToken(entry.runtimeAgentType, tryGetAgentSessionId(previousAgent))
  const shouldKeepResumeToken = !cfg.apiKey || keepResumeToken
  const resumeToken = shouldKeepResumeToken
    ? (storedResumeToken || liveResumeToken)
    : undefined

  if (!shouldKeepResumeToken) {
    server.db.update("user_session", { op: "eq", field: "session_id", value: entry.id }, { cascade_id: "" })
  }

  const tp = getOrCreateTerminalProvider(server, entry.id)
  const pp = getOrCreatePreviewProvider(server, cfg, entry.id)
  const next = await createSessionAgentBinding(server, cfg, entry.id, entry.directory, tp, pp, preferredAgentType, resumeToken)

  entry.chatAgent = next.chatAgent
  entry.agentType = next.agentType
  entry.runtimeAgentType = next.runtimeAgentType
  persistAgentTypeForWindow(server, entry.id, entry.agentType)
  bindSessionAgentEvents(server, cfg, entry, next.chatAgent)

  if (entry.directory) {
    try { next.chatAgent.setWorkingDirectory(entry.directory) } catch { /* ignore */ }
    watchDirectory(server, entry.id, entry.directory)
  }

  persistResumeTokenForWindow(server, entry.id, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
  await destroyChatAgent(previousAgent)
}

async function applyAgentSwitchToSessions(server: AnyCodeServer, cfg: ServerConfig) {
  const entries = Array.from(server.sessions.values())
  for (const entry of entries) {
    server.sessionChatAbort.get(entry.id)?.()
    server.sessionChatAbort.delete(entry.id)
    entry.state.setChatBusy(false)
    await replaceSessionAgent(server, cfg, entry, !cfg.apiKey || entry.agentType === cfg.agent)
  }
}

/**
 * Resume a persisted session row into memory.
 */
async function resumeSession(server: AnyCodeServer, cfg: ServerConfig, row: Record<string, unknown>): Promise<SessionEntry> {
  const sessionId = row.session_id as string
  const cached = server.sessions.get(sessionId)
  if (cached) return cached

  const dir = (row.directory as string) || ""
  const preferredAgentType = getPreferredAgentType(typeof row.agent_type === "string" ? row.agent_type : cfg.agent)
  const resumeToken = getUsableResumeToken(preferredAgentType, (row.cascade_id as string) || undefined)
  console.log(`♻️  Resuming session ${sessionId}, resume_token=${resumeToken || '(none)'}, dir=${dir || '(none)'}`)
  const tp = getOrCreateTerminalProvider(server, sessionId)
  const pp = getOrCreatePreviewProvider(server, cfg, sessionId)

  const next = await createSessionAgentBinding(server, cfg, sessionId, dir, tp, pp, preferredAgentType, resumeToken)

  const entry = registerSession(server, cfg, sessionId, next.chatAgent, dir, row.time_created as number, next.agentType, next.runtimeAgentType)
  persistAgentTypeForWindow(server, sessionId, entry.agentType)
  if (dir) {
    try { next.chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
    watchDirectory(server, sessionId, dir)
  }
  persistResumeTokenForWindow(server, sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
  console.log(`♻️  Session ${sessionId} resumed`)
  return entry
}

/**
 * Create a brand new session/window.
 */
async function createNewWindow(server: AnyCodeServer, cfg: ServerConfig, isDefault = false): Promise<SessionEntry> {
  // Window ID is always server-generated (separate from the agent resume token)
  const sessionId = crypto.randomUUID()
  const tp = getOrCreateTerminalProvider(server, sessionId)
  const pp = getOrCreatePreviewProvider(server, cfg, sessionId)
  const next = await createSessionAgentBinding(server, cfg, sessionId, "", tp, pp, getPreferredAgentType(cfg.agent))
  const now = Date.now()
  ; (tp as any).sessionId = sessionId
  ; (pp as any).sessionId = sessionId
  const entry = registerSession(server, cfg, sessionId, next.chatAgent, "", now, next.agentType, next.runtimeAgentType)

  server.db.insert("user_session", {
    session_id: sessionId,
    directory: "",
    time_created: now,
    is_default: isDefault ? 1 : 0,
    cascade_id: "",
    agent_type: entry.agentType,
  })

  persistResumeTokenForWindow(server, sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
  console.log(`✅  Window ${sessionId} created${isDefault ? " (default)" : ""}`)
  return entry
}

/**
 * Get or create the default window.
 * Returns the default session; creates one if none exists.
 */
async function getOrCreateSession(server: AnyCodeServer, cfg: ServerConfig): Promise<SessionEntry> {
  const rows = server.db.findMany("user_session", {})
  const defaultRow = rows.find((r: any) => r.is_default === 1) || rows[0]

  if (defaultRow) {
    if (defaultRow.is_default !== 1) {
      server.db.update("user_session", { op: "eq", field: "session_id", value: defaultRow.session_id }, { is_default: 1 })
    }
    return resumeSession(server, cfg, defaultRow)
  }

  return createNewWindow(server, cfg, true)
}

/**
 * Get all windows. Resumes any that aren't in memory.
 */
async function getAllWindows(server: AnyCodeServer, cfg: ServerConfig): Promise<SessionEntry[]> {
  const rows = server.db.findMany("user_session", {})
  if (rows.length === 0) {
    return [await createNewWindow(server, cfg, true)]
  }
  const entries: SessionEntry[] = []
  for (const row of rows) {
    entries.push(await resumeSession(server, cfg, row))
  }
  return entries
}

/**
 * Delete a non-default window.
 */
function deleteWindow(server: AnyCodeServer, sessionId: string): boolean {
  const row = server.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
  if (!row) return false
  if ((row as any).is_default === 1) return false // cannot delete default

  // Clean up in-memory state
  const session = server.sessions.get(sessionId)
  if (session) {
    server.sessions.delete(sessionId)
    destroyChatAgent(session.chatAgent).catch(() => { /* ignore */ })
  }
  const tp = server.terminalProviders.get(sessionId)
  if (tp && tp.exists()) {
    try { tp.teardown() } catch { /* ignore */ }
  }
  server.terminalProviders.delete(sessionId)
  server.previewProviders.delete(sessionId)

  // Remove from DB
  server.db.remove("user_session", { op: "eq", field: "session_id", value: sessionId })
  server.db.remove("user_session_message", { op: "eq", field: "session_id", value: sessionId })
  console.log(`🗑  Window ${sessionId} deleted`)
  return true
}

function getSession(server: AnyCodeServer, id: string): SessionEntry | undefined {
  return server.sessions.get(id)
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

/** Compute added/removed line numbers for a single file via git diff. */
async function computeFileDiff(
  dir: string,
  filePath: string,
  /** Pre-read content — avoids re-reading for untracked-file fallback */
  existingContent?: string,
): Promise<{ added: number[]; removed: number[] }> {
  const added: number[] = []
  const removed: number[] = []

  let result = await gitProvider.run(["diff", "--unified=0", "--", filePath], { cwd: dir })
  if (result.exitCode !== 0 || !result.text().trim()) {
    result = await gitProvider.run(["diff", "--unified=0", "--cached", "--", filePath], { cwd: dir })
  }

  const diffText = result.text()
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

  // Completely untracked files — mark all lines as added
  if (!diffText.trim()) {
    try {
      const content = existingContent ?? await fsPromises.readFile(path.resolve(dir, filePath), "utf-8")
      const lineCount = content.split("\n").length
      for (let i = 1; i <= lineCount; i++) added.push(i)
    } catch { /* ignore */ }
  }

  return { added, removed }
}

// ── Channel abstraction ───────────────────────────────────────────────────

/** Minimal interface for WebSocket clients */
interface ClientLike {
  readyState: number
  send(data: string): void
}

function scheduleStatePush(server: AnyCodeServer, sessionId: string, delayMs = 300) {
  const existing = server.statePushTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    server.statePushTimers.delete(sessionId)
    getSession(server, sessionId)?.state.updateFileSystem()
  }, delayMs)
  server.statePushTimers.set(sessionId, timer)
}

function getSessionClients(server: AnyCodeServer, sessionId: string): Set<ClientLike> {
  let set = server.sessionClients.get(sessionId)
  if (!set) {
    set = new Set()
    server.sessionClients.set(sessionId, set)
  }
  return set
}

function removeClient(server: AnyCodeServer, sessionId: string, client: ClientLike) {
  const clients = server.sessionClients.get(sessionId)
  if (clients) {
    clients.delete(client)
    if (clients.size === 0) server.sessionClients.delete(sessionId)
  }
}

function broadcast(server: AnyCodeServer, sessionId: string, data: Record<string, unknown>) {
  const clients = server.sessionClients.get(sessionId)
  if (!clients || clients.size === 0) {
    if ((data as any).type?.startsWith("chat.")) {
      console.warn(`⚠  broadcast(${sessionId}): 0 clients, dropping ${(data as any).type}`)
    }
    return
  }
  const json = JSON.stringify(data)
  let sent = 0
  for (const c of clients) {
    if (c.readyState === WS.OPEN) { c.send(json); sent++ }
  }
  if (sent === 0 && (data as any).type?.startsWith("chat.")) {
    console.warn(`⚠  broadcast(${sessionId}): ${clients.size} clients but 0 OPEN, dropping ${(data as any).type}`)
  }
}

/** Broadcast to ALL connected WebSocket clients across all sessions */
function broadcastAll(server: AnyCodeServer, data: Record<string, unknown>) {
  const json = JSON.stringify(data)
  for (const clients of server.sessionClients.values()) {
    for (const c of clients) {
      if (c.readyState === WS.OPEN) c.send(json)
    }
  }
}



/** Handle incoming client message from WebSocket */
async function handleClientMessage(server: AnyCodeServer, sessionId: string, client: ClientLike, msg: any) {
  // Application-level heartbeat: reply with pong immediately
  if (msg.type === "ping") {
    client.send(JSON.stringify({ type: "pong" }))
    return
  }

  // Per-directory file watching: subscribe/unsubscribe
  if (msg.type === "watch.dir") {
    const manager = server.dirWatchManagers.get(sessionId)
    if (manager && typeof msg.path === "string") {
      manager.watchDir(msg.path)
    }
    return
  }
  if (msg.type === "unwatch.dir") {
    const manager = server.dirWatchManagers.get(sessionId)
    if (manager && typeof msg.path === "string") {
      manager.unwatchDir(msg.path)
    }
    return
  }

  if (msg.type === "ls") {
    const session = getSession(server, sessionId)!
    const dir = session.directory
    if (!dir) return
    const target = path.resolve(dir, msg.path || "")
    if (!target.startsWith(path.resolve(dir))) return
    const entries = await listDir(target)
    client.send(JSON.stringify({ type: "ls", path: msg.path || "", entries }))
  }

  if (msg.type === "readFile") {
    const session = getSession(server, sessionId)!
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
    const session = getSession(server, sessionId)
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

    const wsClients = server.sessionClients.get(sessionId)
    console.log(`💬  chat.send(${sessionId}): "${message.slice(0, 40)}${message.length > 40 ? "..." : ""}" → ${wsClients?.size ?? 0} clients`)
    broadcast(server, sessionId, { type: "chat.userMessage", text: contextLabel })

    let aborted = false
    server.sessionChatAbort.set(sessionId, () => {
      aborted = true
      session.chatAgent.abort?.()
    })

    session.state.setChatBusy(true)

    try {
      for await (const event of session.chatAgent.chat(effectiveMessage)) {
        if (aborted) break
        broadcast(server, sessionId, { type: "chat.event", event })
      }
    } catch (err: any) {
      broadcast(server, sessionId, { type: "chat.event", event: { type: "error", error: err.message } })
    }

    server.sessionChatAbort.delete(sessionId)
    session.state.setChatBusy(false)
    // Update context usage after chat turn
    session.chatAgent.getContext().then((ctx: any) => {
      if (ctx) session.state.setContext(ctx.contextUsed ?? 0, ctx.compactionThreshold ?? 0)
    }).catch(() => {})
    broadcast(server, sessionId, { type: "chat.done" })
  }

  if (msg.type === "chat.stop") {
    server.sessionChatAbort.get(sessionId)?.()
  }
}

/**
 * Per-directory watcher manager.
 * Only watches directories the client is actively viewing (expanded in file tree).
 * Each directory gets a non-recursive chokidar watcher with polling.
 */
class DirectoryWatchManager {
  private server: AnyCodeServer
  private watchers = new Map<string, ChokidarWatcher>()
  private sessionId: string
  private rootDir: string
  private cfg: ServerConfig
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private gitTimer: ReturnType<typeof setTimeout> | undefined
  private pendingDirs = new Set<string>()

  constructor(server: AnyCodeServer, cfg: ServerConfig, sessionId: string, rootDir: string) {
    this.server = server
    this.cfg = cfg
    this.sessionId = sessionId
    this.rootDir = rootDir
    // Always watch the top-level directory
    if (rootDir) {
      this.watchDir("")
      // Watch .git for commit/checkout/merge etc. — these change git status
      this._watchGitDir()
    }
  }

  /** Watch .git internals (index, HEAD, refs) to detect commits/checkouts. */
  private _watchGitDir() {
    const gitDir = path.join(this.rootDir, ".git")
    try {
      fs.accessSync(gitDir)
    } catch {
      return // no .git directory — not a git repo
    }
    const gitWatcher = chokidarWatch(gitDir, {
      ignored: /(objects|logs|hooks|info)/,
      ignoreInitial: true,
      depth: 2, // covers refs/heads/*
      usePolling: true,
      interval: 3000,
    })
    gitWatcher.on("all", () => {
      // Debounce and call scheduleStatePush directly (not _flush,
      // since _flush early-returns when pendingDirs is empty)
      if (this.gitTimer) return
      this.gitTimer = setTimeout(() => {
        this.gitTimer = undefined
        this.server.scheduleStatePush(this.sessionId, 0)
      }, 500)
    })
    gitWatcher.on("error", () => {}) // silently ignore
    this.watchers.set("__git__", gitWatcher)
  }

  /** Watch a single directory (relative path from rootDir). Non-recursive. */
  watchDir(relPath: string) {
    if (this.watchers.has(relPath)) return
    const absPath = relPath ? path.join(this.rootDir, relPath) : this.rootDir

    const watcher = chokidarWatch(absPath, {
      ignored: /(^|[\/\\])(\.git|node_modules)([\/\\]|$)/,
      ignoreInitial: true,
      depth: 0, // non-recursive: only this directory level
      usePolling: true,
      interval: 3000,
    })

    watcher.on("all", () => {
      this.pendingDirs.add(relPath)
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this._flush(), 500)
      }
    })
    watcher.on("error", (err) => console.error(`❌  watch error ${absPath}:`, err))

    this.watchers.set(relPath, watcher)
  }

  /** Stop watching a directory */
  unwatchDir(relPath: string) {
    // Don't unwatch root
    if (relPath === "") return
    const watcher = this.watchers.get(relPath)
    if (watcher) {
      watcher.close()
      this.watchers.delete(relPath)
    }
  }

  /** Flush batched changes: broadcast fs.changed + trigger state refresh */
  private _flush() {
    this.batchTimer = undefined
    if (this.pendingDirs.size === 0) return
    const dirs = [...this.pendingDirs]
    this.pendingDirs = new Set()

    const clients = this.server.getSessionClients(this.sessionId)
    const msg = JSON.stringify({ type: "fs.changed", dirs })
    for (const c of clients) {
      if (c.readyState === WS.OPEN) c.send(msg)
    }

    // Also refresh top-level + git status
    this.server.scheduleStatePush(this.sessionId, 0)
  }

  /** Close all watchers */
  destroy() {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
  }
}

function watchDirectory(server: AnyCodeServer, sessionId: string, dir: string) {
  // Clean up existing
  const existing = server.dirWatchManagers.get(sessionId)
  if (existing) {
    existing.destroy()
    server.dirWatchManagers.delete(sessionId)
  }

  if (!dir) return

  const manager = new DirectoryWatchManager(server, server.cfg, sessionId, dir)
  server.dirWatchManagers.set(sessionId, manager)
  console.log(`👁  Watching directory: ${dir}`)
}

export class SessionStateModel {
  server: AnyCodeServer
  sessionId: string
  cfg: ServerConfig
  directory: string = ""
  topLevel: any[] = []
  changes: any[] = []
  previewPort: number | null = null
  chatBusy: boolean = false
  contextUsed: number = 0
  compactionThreshold: number = 0

  private _isComputing = false
  private _needsCompute = false

  constructor(server: AnyCodeServer, sessionId: string, cfg: ServerConfig) {
    this.server = server
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
    const expectedPort = this.server.getPreviewPortForSession(this.sessionId)
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

  setContext(used: number, threshold: number) {
    if (this.contextUsed !== used || this.compactionThreshold !== threshold) {
      this.contextUsed = used
      this.compactionThreshold = threshold
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
      contextUsed: this.contextUsed,
      compactionThreshold: this.compactionThreshold,
    }
  }

  notify() {
    const json = JSON.stringify(this.toJSON())
    const clients = this.server.getSessionClients(this.sessionId)
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
 * Uses a headless xterm.js instance as the authoritative terminal state.
 * Clients get a serialized snapshot on connect, then receive live raw
 * output for optimistic updates.
 */
class TerminalStateModel {
  private headless: InstanceType<typeof xtermHeadless.Terminal>
  private serializer: InstanceType<typeof SerializeAddon>
  private alive = false
  private wsClients = new Set<WS>()

  // Callbacks set by NodeTerminalProvider
  onInput: ((data: string) => void) | null = null
  onResize: ((cols: number, rows: number) => void) | null = null

  constructor() {
    console.log("🖥  [TermModel] created headless 80×24, scrollback=5000")
    this.headless = new xtermHeadless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.headless.loadAddon(this.serializer)
  }

  /** Update alive state and notify clients */
  setAlive(alive: boolean): void {
    console.log(`🖥  [TermModel] setAlive: ${this.alive} → ${alive}, clients=${this.wsClients.size}`)
    this.alive = alive
    this.notify({ type: alive ? "terminal.ready" : "terminal.none" })
  }

  /** Feed output to headless terminal and broadcast to clients */
  pushOutput(data: string): void {
    console.log(`🖥  [TermModel] pushOutput: ${data.length}b → broadcast to ${this.wsClients.size} clients`)
    this.headless.write(data)
    this.notify({ type: "terminal.output", data })
  }

  /** Push a terminal exited event */
  pushExited(exitCode: number): void {
    console.log(`🖥  [TermModel] exited: code=${exitCode}`)
    this.notify({ type: "terminal.exited", exitCode })
  }

  /** Resize the headless terminal to match PTY */
  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      console.log(`🖥  [TermModel] resize: headless → ${cols}×${rows}`)
      this.headless.resize(cols, rows)
    }
  }

  /** Reset: dispose old headless terminal and create a fresh one */
  reset(): void {
    console.log("🖥  [TermModel] reset: disposing + recreating headless")
    this.headless.dispose()
    this.headless = new xtermHeadless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.headless.loadAddon(this.serializer)
  }

  /** Broadcast a message to all connected clients */
  private notify(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg)
    for (const ws of this.wsClients) {
      if (ws.readyState === WS.OPEN) ws.send(json)
    }
  }

  /** Register a new WebSocket client */
  handleClient(ws: WS): void {
    // 1. Current state
    ws.send(JSON.stringify({ type: this.alive ? "terminal.ready" : "terminal.none" }))

    // 2. Snapshot
    const snapshot = this.serializer.serialize()
    console.log(`🖥  [TermModel] handleClient: alive=${this.alive}, clients=${this.wsClients.size}`)
    if (snapshot) {
      ws.send(JSON.stringify({ type: "terminal.sync", data: snapshot }))
    }

    // 3. Join live broadcast
    console.log(`🖥  [TermModel] serialize() → ${snapshot?.length ?? 0} chars`)
    this.wsClients.add(ws)

    // 4. Messages
    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "terminal.input") {
          this.onInput?.(msg.data)
        } else if (msg.type === "terminal.resize") {
          this.resize(msg.cols, msg.rows)
          this.onResize?.(msg.cols, msg.rows)
          // Resend snapshot at new dimensions (client does reset+write)
          const snap = this.serializer.serialize()
          if (snap) ws.send(JSON.stringify({ type: "terminal.sync", data: snap }))
        }
      } catch { /* ignore */ }
    })

    // 5. Cleanup
    ws.on("close", () => {
      this.wsClients.delete(ws)
      console.log(`🖥  [TermModel] client left, remaining=${this.wsClients.size}`)
    })
  }
}

/**
 * NodeTerminalProvider — per-session PTY process manager.
 *
 * Manages PTY lifecycle (create/destroy/write/read/resize).
 * Feeds output to TerminalStateModel for client sync.
 */
class NodeTerminalProvider implements TerminalProvider {
  private server: AnyCodeServer
  private proc: pty.IPty | null = null
  private lines: string[] = []
  private currentLine = ""
  private sessionId: string
  readonly model: TerminalStateModel

  constructor(server: AnyCodeServer, sessionId: string) {
    this.server = server
    this.sessionId = sessionId
    this.model = new TerminalStateModel()
    this.model.onInput = (data) => this.proc?.write(data)
    this.model.onResize = (cols, rows) => this.resize(cols, rows)
  }

  exists(): boolean { return this.proc !== null }

  ensureRunning(reset?: boolean): void {
    if (this.proc && !reset) return  // already running, nothing to do
    if (this.proc) this.teardown()   // reset: tear down first
    this.spawn()
  }

  spawn(): void {
    const session = this.server.getSession(this.sessionId)
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

  teardown(): void {
    if (!this.proc) return
    console.log(`🖥  Terminal destroyed for session ${this.sessionId}`)
    this.proc.kill()
    this.proc = null
    this.lines = []
    this.currentLine = ""
    this.model.reset()
    this.model.setAlive(false)
  }

  write(data: string): void {
    this.ensureRunning()
    this.proc!.write(data)
  }

  read(lineCount: number): string {
    if (!this.proc) return "(no terminal)"
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

function getOrCreateTerminalProvider(server: AnyCodeServer, sessionId: string): NodeTerminalProvider {
  let tp = server.terminalProviders.get(sessionId)
  if (!tp) {
    tp = new NodeTerminalProvider(server, sessionId)
    server.terminalProviders.set(sessionId, tp)
  }
  return tp
}

function handleTerminalWs(server: AnyCodeServer, ws: WS, sessionId: string) {
  getOrCreateTerminalProvider(server, sessionId).model.handleClient(ws)
}




class NodePreviewProvider implements PreviewProvider {
  sessionId: string

  private server: AnyCodeServer
  private cfg: ServerConfig
  constructor(server: AnyCodeServer, cfg: ServerConfig, sessionId: string) {
    this.server = server
    this.cfg = cfg
    this.sessionId = sessionId
  }

  setPreviewTarget(forwardedLocalUrl: string): void {
    const previewTarget = this.server.setPreviewTarget(this.sessionId, forwardedLocalUrl)
    console.log(`🔗  Preview proxy: :${this.cfg.previewPort} → ${previewTarget} (session ${this.sessionId})`)

    // Let the reactive state model handle the broadcast natively
    this.server.getSession(this.sessionId)?.state.setPreviewPort(this.cfg.previewPort)
  }
}

function getOrCreatePreviewProvider(server: AnyCodeServer, cfg: ServerConfig, sessionId: string): NodePreviewProvider {
  let pp = server.previewProviders.get(sessionId)
  if (!pp) {
    pp = new NodePreviewProvider(server, cfg, sessionId)
    server.previewProviders.set(sessionId, pp)
  }
  return pp
}

/** Dedicated preview HTTP server — proxies all requests to the current target */
function createPreviewServer(server: AnyCodeServer, cfg: ServerConfig): http.Server {
  const previewServer = createServer(cfg, (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    if (!server.previewTarget) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("No preview target configured")
      return
    }

    try {
      const targetUrl = server.previewTarget + (req.url || "/")
      const parsed = new URL(targetUrl)
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: parsed.host },
      }

      // Buffer request body so we can replay on retry
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        const RETRY_DELAY = 2000

        const attempt = () => {
          const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          })

          proxyReq.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ECONNREFUSED" && !res.destroyed) {
              setTimeout(attempt, RETRY_DELAY)
            } else {
              if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
              res.end(`Preview proxy error: ${err.message}`)
            }
          })

          proxyReq.end(body)
        }
        attempt()
      })
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end(`Invalid proxy target: ${err.message}`)
    }
  })

  // WebSocket upgrade proxy — needed for HMR (Vite, webpack, etc.)
  previewServer.on("upgrade", (req, socket, head) => {
    if (!server.previewTarget) {
      socket.destroy()
      return
    }

    try {
      const parsed = new URL(server.previewTarget)
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

export class AnyCodeServer {
  readonly anycodeDir: string
  readonly dbPath: string
  readonly settingsStore: SettingsStore
  readonly gitProvider = new NodeGitProvider()

  cfg: ServerConfig
  sharedStorage!: SqlJsStorage
  db!: NoSqlDb

  readonly sessions = new Map<string, SessionEntry>()
  readonly sessionClients = new Map<string, Set<ClientLike>>()
  readonly sessionChatAbort = new Map<string, () => void>()
  readonly statePushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  readonly dirWatchManagers = new Map<string, DirectoryWatchManager>()
  readonly terminalProviders = new Map<string, NodeTerminalProvider>()
  readonly previewProviders = new Map<string, NodePreviewProvider>()

  previewTarget: string | null = null
  previewSessionId: string | null = null
  previewServer: http.Server | null = null
  mainServer: http.Server | null = null
  wss: WebSocketServer | null = null
  pingTimer: ReturnType<typeof setInterval> | null = null
  appDistExists = false

  constructor(options: AnyCodeServerOptions = {}) {
    this.anycodeDir = options.anycodeDir ?? DEFAULT_ANYCODE_DIR
    this.dbPath = options.dbPath ?? path.join(this.anycodeDir, "data.db")
    this.settingsStore = options.settingsStore ?? new SettingsStore({ anycodeDir: this.anycodeDir })
    this.cfg = options.config ?? this.loadConfig()
  }

  getSession(id: string) {
    return getSession(this, id)
  }

  getSessionClients(sessionId: string) {
    return getSessionClients(this, sessionId)
  }

  scheduleStatePush(sessionId: string, delayMs = 300) {
    scheduleStatePush(this, sessionId, delayMs)
  }

  getPreviewPortForSession(sessionId: string) {
    return this.previewSessionId === sessionId && this.previewTarget ? this.cfg.previewPort : null
  }

  setPreviewTarget(sessionId: string, forwardedLocalUrl: string) {
    try {
      const u = new URL(forwardedLocalUrl)
      if (u.hostname === "localhost") u.hostname = "127.0.0.1"
      this.previewTarget = u.origin
    } catch {
      this.previewTarget = forwardedLocalUrl.replace(/\/+$/, "")
    }
    this.previewSessionId = sessionId
    return this.previewTarget
  }

  readUserSettingsFile(): UserSettingsFile {
    return this.settingsStore.read().toJSON()
  }

  writeUserSettingsFile(settings: UserSettingsFile) {
    return this.settingsStore.write(settings).toJSON()
  }

  applySettingsToConfig(settings: UserSettingsFile) {
    const runtime = new SettingsModel(settings).resolveRuntime()
    this.cfg.userSettings = runtime.userSettings
    this.cfg.agent = runtime.agent
    this.cfg.provider = runtime.provider
    this.cfg.apiKey = runtime.apiKey
    this.cfg.baseUrl = runtime.baseUrl
    this.cfg.model = runtime.model
  }

  private loadConfig(): ServerConfig {
    const runtime = this.settingsStore.read().resolveRuntime()
    const userSettings = runtime.userSettings
    const agent = runtime.agent
    const provider = runtime.provider
    const model = runtime.model
    const apiKey = runtime.apiKey
    const baseUrl = runtime.baseUrl
    const port = parseInt(process.env.PORT ?? "3210", 10)
    const previewPort = parseInt(process.env.PREVIEW_PORT ?? String(port + 1), 10)
    if (!provider) {
      console.error("❌  Missing PROVIDER")
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

  private registerProcessErrorHandlers() {
    process.on("uncaughtException", (err) => {
      console.error("⚠  Uncaught exception:", err.message)
    })
    process.on("unhandledRejection", (reason) => {
      console.error("⚠  Unhandled rejection:", reason instanceof Error ? reason.message : reason)
    })
  }

  private async initializeStorage() {
    this.sharedStorage = new SqlJsStorage(this.dbPath)
    this.db = await this.sharedStorage.connect()

    const cols = this.sharedStorage.query(`PRAGMA table_info("user_session")`)
    if (cols.length > 0) {
      const hasIsDefault = cols.some((c: any) => c.name === "is_default")
      const hasUserId = cols.some((c: any) => c.name === "user_id")
      const pkCol = cols.find((c: any) => c.pk === 1)
      const needsPkMigration = pkCol && pkCol.name === "user_id"
      const needsMigration = !hasIsDefault || needsPkMigration || hasUserId

      if (needsMigration) {
        console.log("🔄  Migrating user_session table…")
        if (!hasIsDefault) {
          this.sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "is_default" INTEGER NOT NULL DEFAULT 0`)
          this.sharedStorage.exec(`UPDATE "user_session" SET "is_default" = 1`)
        }
        if (needsPkMigration || hasUserId) {
          this.sharedStorage.exec(`CREATE TABLE "user_session_new" (
            "session_id"   TEXT PRIMARY KEY,
            "directory"    TEXT NOT NULL DEFAULT '',
            "time_created" INTEGER NOT NULL,
            "is_default"   INTEGER NOT NULL DEFAULT 0
          )`)
          this.sharedStorage.exec(`INSERT INTO "user_session_new" SELECT "session_id","directory","time_created","is_default" FROM "user_session"`)
          this.sharedStorage.exec(`DROP TABLE "user_session"`)
          this.sharedStorage.exec(`ALTER TABLE "user_session_new" RENAME TO "user_session"`)
        }
        console.log("✅  user_session migration complete")
      }
      if (!cols.some((c: any) => c.name === "cascade_id")) {
        this.sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "cascade_id" TEXT NOT NULL DEFAULT ''`)
        console.log("✅  Added cascade_id column to user_session")
      }
      if (!cols.some((c: any) => c.name === "agent_type")) {
        this.sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "agent_type" TEXT NOT NULL DEFAULT 'anycode'`)
        console.log("✅  Added agent_type column to user_session")
      }
    } else {
      this.sharedStorage.exec(`
        CREATE TABLE IF NOT EXISTS "user_session" (
          "session_id"   TEXT PRIMARY KEY,
          "directory"    TEXT NOT NULL DEFAULT '',
          "time_created" INTEGER NOT NULL,
          "is_default"   INTEGER NOT NULL DEFAULT 0,
          "cascade_id"   TEXT NOT NULL DEFAULT '',
          "agent_type"   TEXT NOT NULL DEFAULT 'anycode'
        )
      `)
    }

    this.sharedStorage.exec(`
      CREATE TABLE IF NOT EXISTS "user_session_message" (
        "id"           INTEGER PRIMARY KEY AUTOINCREMENT,
        "session_id"   TEXT NOT NULL,
        "role"         TEXT NOT NULL,
        "text"         TEXT NOT NULL DEFAULT '',
        "time_created" INTEGER NOT NULL
      )
    `)
    this.sharedStorage.exec(`CREATE INDEX IF NOT EXISTS "idx_user_session_message_session_time" ON "user_session_message" ("session_id", "id")`)
  }

  async start() {
    this.registerProcessErrorHandlers()
    console.log("🚀  Starting @any-code/server…")

    await this.initializeStorage()
    this.previewServer = createPreviewServer(this, this.cfg)
    this.mainServer = createMainServer(this, this.cfg)
    this.appDistExists = fs.existsSync(this.cfg.appDist)

    const wss = new WebSocketServer({ server: this.mainServer })
    this.wss = wss

    const WS_PING_INTERVAL = 30_000
    const aliveSet = new WeakSet<WS>()
    this.pingTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (!aliveSet.has(ws)) {
          ws.terminate()
          continue
        }
        aliveSet.delete(ws)
        ws.ping()
      }
    }, WS_PING_INTERVAL)
    wss.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
    })

    wss.on("connection", (ws, req) => {
      const url = new URL(req.url || "/", `http://localhost:${this.cfg.port}`)
      const sessionId = url.searchParams.get("sessionId")
      if (!sessionId || !this.getSession(sessionId)) {
        ws.close(4001, "Invalid session")
        return
      }

      aliveSet.add(ws)
      ws.on("pong", () => aliveSet.add(ws))

      if (url.pathname === "/terminal") {
        handleTerminalWs(this, ws, sessionId)
        return
      }

      const clients = this.getSessionClients(sessionId)
      clients.add(ws as ClientLike)
      console.log(`🔌  WS client connected to session ${sessionId} (${clients.size} total)`)

      const sessionModel = this.getSession(sessionId)?.state
      if (sessionModel) {
        ws.send(JSON.stringify(sessionModel.toJSON()))
      }

      ws.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          handleClientMessage(this, sessionId, ws as ClientLike, msg).catch(() => { })
        } catch { /* ignore malformed */ }
      })

      ws.on("close", () => {
        removeClient(this, sessionId, ws as ClientLike)
      })
    })

    const HOST = process.env.HOST ?? "0.0.0.0"
    const proto = this.cfg.tlsCert ? "https" : "http"
    const wsProto = this.cfg.tlsCert ? "wss" : "ws"

    this.previewServer.listen(this.cfg.previewPort, HOST, () => {
      console.log(`👁  Preview proxy: ${proto}://${HOST}:${this.cfg.previewPort}`)
    })

    this.mainServer.listen(this.cfg.port, HOST, () => {
      console.log(`🌐  ${proto}://${HOST}:${this.cfg.port}`)
      console.log(`🤖  Provider: ${this.cfg.provider} / ${this.cfg.model}`)
      console.log(`🖥  Admin: ${proto}://${HOST}:${this.cfg.port}/admin`)
      if (this.appDistExists) {
        console.log(`📱  App: ${proto}://${HOST}:${this.cfg.port}`)
      } else {
        console.log(`⚠  App dist not found at ${this.cfg.appDist} — run 'pnpm --filter @any-code/app build' first`)
      }
      console.log(`📋  Sessions: POST /api/sessions to create`)
      console.log(`🔌  WebSocket: ${wsProto}://${HOST}:${this.cfg.port}?sessionId=xxx`)
      if (this.cfg.tlsCert) console.log(`🔒  TLS enabled`)
    })

    return this
  }
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
    const data = fs.readFileSync(filePath)
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.length,
    })
    res.end(data)
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

async function readJsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return {}
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendErrorJson(res: http.ServerResponse, status: number, error: unknown, fallbackMessage = "Request failed") {
  const message = error instanceof Error ? error.message : fallbackMessage
  const code = getErrorCode(error)
  sendJson(res, status, code ? { error: message, code } : { error: message })
}

// ── HTTP Server ────────────────────────────────────────────────────────────

function createMainServer(server: AnyCodeServer, cfg: ServerConfig): http.Server {
  const httpServer = createServer(cfg, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    // ── Static files first — never blocked by async API operations ──
    if (req.method === "GET" && !req.url?.startsWith("/api/") && !req.url?.startsWith("/admin")) {
      if (serveStatic(cfg, req, res)) return
      if (serveAppIndex(cfg, res)) return
    }

    if (req.method === "GET" && req.url === "/api/settings") {
      const settings = server.readUserSettingsFile()
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        accounts: settings.accounts ?? [],
        currentAccountId: settings.currentAccountId ?? null,
      }))
      return
    }

    if (req.method === "POST" && req.url === "/api/settings") {
      const previous = server.readUserSettingsFile()
      const body = await readJsonBody(req)
      const rawAccounts = Array.isArray(body.accounts) ? body.accounts : []
      const applyCurrentAccount = body.applyCurrentAccount === true

      const invalidAccount = rawAccounts.find((account: unknown) => (
        !account ||
        typeof account !== "object" ||
        !normalizeString((account as Record<string, unknown>).name) ||
        !normalizeString((account as Record<string, unknown>).AGENT) ||
        !normalizeString((account as Record<string, unknown>).PROVIDER) ||
        !normalizeString((account as Record<string, unknown>).MODEL)
      ))
      if (invalidAccount) {
        const invalidName = normalizeString((invalidAccount as Record<string, unknown>).name)
          ?? normalizeString((invalidAccount as Record<string, unknown>).id)
          ?? "unknown"
        sendJson(res, 400, {
          error: `Account "${invalidName}" is incomplete`,
          code: API_ERROR_CODES.SETTINGS_ACCOUNT_INCOMPLETE,
        })
        return
      }

      const next = new SettingsModel({
        ...previous,
        accounts: rawAccounts,
        currentAccountId: typeof body.currentAccountId === "string" ? body.currentAccountId : null,
      }).toJSON()

      if (!applyCurrentAccount) {
        const saved = server.writeUserSettingsFile(next)
        sendJson(res, 200, {
          ok: true,
          accounts: saved.accounts ?? [],
          currentAccountId: saved.currentAccountId ?? null,
        })
        return
      }

      try {
        server.applySettingsToConfig(next)
        await applyAgentSwitchToSessions(server, cfg)
        server.writeUserSettingsFile(next)
      } catch (err: any) {
        server.applySettingsToConfig(previous)
        try {
          await applyAgentSwitchToSessions(server, cfg)
        } catch (rollbackErr) {
          console.error("⚠  Failed to roll back account switch:", rollbackErr)
        }
        sendErrorJson(res, 500, err, "Failed to save settings")
        return
      }

      sendJson(res, 200, {
        ok: true,
        accounts: next.accounts ?? [],
        currentAccountId: next.currentAccountId ?? null,
      })
      return
    }

    // ── Session management ──
    if (req.method === "POST" && req.url === "/api/sessions") {
      getOrCreateSession(server, cfg).then((entry) => {
        sendJson(res, 200, { id: entry.id, directory: entry.directory })
      }).catch((err: any) => {
        sendErrorJson(res, 500, err)
      })
      return
    }

    if (req.method === "GET" && req.url === "/api/sessions") {
      const list = Array.from(server.sessions.values()).map((s) => ({
        id: s.id, directory: s.directory, createdAt: s.createdAt,
      }))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(list))
      return
    }

    // ── Window management APIs ───────────────────────────────────────────
    // GET /api/windows — list all windows
    if (req.method === "GET" && req.url?.startsWith("/api/windows")) {
      getAllWindows(server, cfg).then(async (entries) => {
        const rows = server.db.findMany("user_session", {})
        const defaultMap = new Map(rows.map((r: any) => [r.session_id, r.is_default === 1]))
        const list = entries.map((e) => ({
          id: e.id,
          title: e.title || "",
          directory: e.directory,
          createdAt: e.createdAt,
          isDefault: defaultMap.get(e.id) ?? false,
        }))
        sendJson(res, 200, list)
      }).catch((err: any) => {
        sendErrorJson(res, 500, err)
      })
      return
    }

    // POST /api/windows — create new window
    if (req.method === "POST" && req.url === "/api/windows") {
      createNewWindow(server, cfg, false).then((entry) => {
        sendJson(res, 200, { id: entry.id, directory: entry.directory, isDefault: false })
      }).catch((err: any) => {
        sendErrorJson(res, 500, err)
      })
      return
    }

    // DELETE /api/windows/:id — delete non-default window
    const windowDeleteMatch = req.url?.match(/^\/api\/windows\/([^/?]+)$/)
    if (req.method === "DELETE" && windowDeleteMatch) {
      const ok = deleteWindow(server, windowDeleteMatch[1])
      if (ok) {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      } else {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Cannot delete default window or window not found" }))
      }
      return
    }

    // GET|POST /api/sessions/:id/...
    const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/?]+)(?:\/([a-z]+))?/)
    if ((req.method === "GET" || req.method === "POST") && sessionMatch) {
      const session = getSession(server, sessionMatch[1])
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
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ directory: dir, topLevel, changes, previewPort: server.getPreviewPortForSession(session.id) }))
        return
      }

      // POST /api/sessions/:id/files — unified batch endpoint for files + directories
      if (sub === "files" && req.method === "POST") {
        const dir = session.directory
        if (!dir) {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ files: {} }))
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        let paths: string[] = []
        let withDiff = false
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          paths = body.paths ?? []
          withDiff = body.withDiff === true
        } catch { /* ignore */ }

        const resolvedDir = path.resolve(dir)
        const results: Record<string, { content?: string; entries?: DirEntry[]; diff?: { added: number[]; removed: number[] }; error?: string }> = {}
        const BATCH_LIMIT = 1024 * 1024 // 1 MB total for file content
        let totalRead = 0

        for (const filePath of paths) {
          const target = path.resolve(dir, filePath)
          if (!target.startsWith(resolvedDir)) {
            results[filePath] = { error: "Forbidden" }
            continue
          }
          try {
            const stat = await fsPromises.stat(target)

            // Directory → return listing
            if (stat.isDirectory()) {
              const entries = await listDir(target)
              results[filePath] = { entries }
              continue
            }

            // File → return content (with size checks)
            if (totalRead >= BATCH_LIMIT) {
              results[filePath] = { error: "Batch limit reached" }
              continue
            }
            if (stat.size > 512 * 1024) {
              results[filePath] = { error: "File too large" }
              continue
            }
            if (totalRead + stat.size > BATCH_LIMIT) {
              results[filePath] = { error: "Batch limit reached" }
              continue
            }
            const content = await fsPromises.readFile(target, "utf-8")
            totalRead += stat.size
            const entry: typeof results[string] = { content }
            if (withDiff) {
              entry.diff = await computeFileDiff(dir, filePath, content)
            }
            results[filePath] = entry
          } catch {
            results[filePath] = { error: "读取失败" }
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ files: results }))
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
      const list = await Promise.all(Array.from(server.sessions.values()).map(async (s) => ({
        id: s.id, directory: s.directory,
        stats: await s.chatAgent.getUsage(),
        sessionId: tryGetAgentSessionId(s.chatAgent),
        resumeToken: tryGetAgentSessionId(s.chatAgent),
      })))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ sessions: list }))
      return
    }

    // GET /api/messages?sessionId=xxx
    if (req.method === "GET" && req.url?.startsWith("/api/messages")) {
      const url = new URL(req.url, `http://localhost:${cfg.port}`)
      const sessionId = url.searchParams.get("sessionId")
      let session = sessionId ? getSession(server, sessionId) : undefined

      // Session may not be in memory after server restart — try resuming from DB
      if (!session && sessionId) {
        const row = server.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
        if (row) {
          try {
            session = await resumeSession(server, cfg, row as Record<string, unknown>)
          } catch { /* ignore resume errors */ }
        }
      }

      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Session not found" }))
        return
      }
      const limit = 30
      session.chatAgent.getSessionMessages({ limit }).then((messages: any) => {
        const payload = session.runtimeAgentType === NO_AGENT_TYPE
          ? messages
          : mergeSessionHistoryMessages(getPersistedNoAgentMessages(server, session.id, limit), messages, limit)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(payload))
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
  return httpServer
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function startServer() {
  return new AnyCodeServer().start()
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider };
export type { VirtualFileSystem, StorageProvider, Migration } from "@any-code/utils"
