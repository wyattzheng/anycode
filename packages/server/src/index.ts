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
import https from "https"
import { fileURLToPath } from "url"
import path from "path"
import os from "os"
import fs from "fs"
import fsPromises from "fs/promises"
import { spawn as cpSpawn } from "child_process"
import { CodeAgent, type NoSqlDb, type TerminalProvider, type PreviewProvider } from "@any-code/agent"
import { SetWorkingDirectoryTool } from "./tool-set-directory"
import { TerminalTool } from "./tool-terminal-write"
import { SetPreviewUrlTool } from "./tool-set-preview-url"
import { WebSocketServer, WebSocket as WS } from "ws"
import { SqlJsStorage, NodeFS, NodeSearchProvider } from "@any-code/utils"
import { getDuplicateAccountName, SettingsModel, SettingsStore, normalizeString, type UserSettingsFile } from "@any-code/settings"
import { VendorRegistry } from "@any-code/provider"
import { createChatAgent, type IChatAgent } from "./chat-agent"
import { adminHTML } from "./admin"
import { computeFileDiff, type DirEntry, getGitChanges, listDir } from "./filesystem"
import { NodeGitProvider } from "./git"
import { createPreviewServer, getOrCreatePreviewProvider, NodePreviewProvider } from "./preview"
import { DirectoryWatchManager, SessionStateModel, watchDirectory } from "./session-state"
import { getOrCreateTerminalProvider, handleTerminalWs, NodeTerminalProvider } from "./terminal"

// ── Paths ──────────────────────────────────────────────────────────────────

const DEFAULT_ANYCODE_DIR = path.join(os.homedir(), ".anycode")
const NO_AGENT_TYPE = "noagent"
const API_ERROR_CODES = {
  SETTINGS_ACCOUNT_INCOMPLETE: "SETTINGS_ACCOUNT_INCOMPLETE",
  SETTINGS_ACCOUNT_NAME_DUPLICATE: "SETTINGS_ACCOUNT_NAME_DUPLICATE",
  OAUTH_PROVIDER_UNSUPPORTED: "OAUTH_PROVIDER_UNSUPPORTED",
  OAUTH_SESSION_NOT_FOUND: "OAUTH_SESSION_NOT_FOUND",
  OAUTH_SESSION_EXPIRED: "OAUTH_SESSION_EXPIRED",
  OAUTH_TOKEN_EXCHANGE_FAILED: "OAUTH_TOKEN_EXCHANGE_FAILED",
} as const
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
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

interface OAuthSessionRecord {
  id: string
  provider: string
  state: string
  redirectUri: string
  createdAt: number
  status: "pending" | "success" | "error"
  apiKey?: string
  exchangeData?: Record<string, string>
  error?: string
}

interface RuntimeConfigResolution {
  config: ServerConfig
  persistedApiKey?: string
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

  const runtimeResolution = await resolveRuntimeConfig(cfg)
  if (runtimeResolution.persistedApiKey && runtimeResolution.persistedApiKey !== cfg.apiKey) {
    server.persistCurrentAccountApiKey(runtimeResolution.persistedApiKey)
  }
  const runtimeCfg = runtimeResolution.config
  const chatAgent = await createChatAgent(runtimeCfg.agent, createChatAgentConfig(server, runtimeCfg, directory, terminal, preview, resumeToken))
  await chatAgent.init()
  return {
    chatAgent,
    agentType: runtimeCfg.agent,
    runtimeAgentType: runtimeCfg.agent,
  }
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

function getErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined
}

function createApiError(message: string, code: string) {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

function getFirstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return normalizeString(value[0])
  if (typeof value !== "string") return undefined
  return normalizeString(value.split(",")[0])
}

function normalizeForwardedToken(value: string | undefined) {
  return normalizeString(value?.replace(/^"|"$/g, ""))
}

function getForwardedBaseUrl(req: http.IncomingMessage, cfg: ServerConfig) {
  const forwarded = normalizeString(req.headers.forwarded)
  if (forwarded) {
    const first = forwarded.split(",")[0] ?? ""
    const protoMatch = first.match(/(?:^|;)\s*proto=([^;]+)/i)
    const hostMatch = first.match(/(?:^|;)\s*host=([^;]+)/i)
    const proto = normalizeForwardedToken(protoMatch?.[1])?.replace(/:$/, "")
    const host = normalizeForwardedToken(hostMatch?.[1])
    if (host && (proto === "http" || proto === "https")) {
      return `${proto}://${host}`
    }
  }

  const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"])
  if (!forwardedHost) return undefined

  const forwardedProto = getFirstHeaderValue(req.headers["x-forwarded-proto"])?.replace(/:$/, "")
  const forwardedPort = getFirstHeaderValue(req.headers["x-forwarded-port"])
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : (cfg.tlsCert ? "https" : "http")
  const host = forwardedHost.includes(":") || !forwardedPort
    ? forwardedHost
    : `${forwardedHost}:${forwardedPort}`
  return `${protocol}://${host}`
}

async function resolveRuntimeConfig(cfg: ServerConfig): Promise<RuntimeConfigResolution> {
  const resolved = await VendorRegistry.getVendorProvider({ id: cfg.provider }).resolveApiKey({
    apiKey: cfg.apiKey,
    agent: cfg.agent,
  }).catch((): { apiKey: string, persistedApiKey?: string } => ({ apiKey: cfg.apiKey }))
  const runtimeCfg = resolved.apiKey === cfg.apiKey ? cfg : { ...cfg, apiKey: resolved.apiKey }
  return {
    config: runtimeCfg,
    ...(resolved.persistedApiKey && resolved.persistedApiKey !== cfg.apiKey
      ? { persistedApiKey: resolved.persistedApiKey }
      : {}),
  }
}

function normalizePublicBaseUrl(value: unknown) {
  const normalized = normalizeString(value)
  if (!normalized) return undefined
  try {
    const url = new URL(normalized)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "0.0.0.0") {
      url.hostname = "localhost"
    }
    return url.origin + url.pathname.replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

function getRequestBaseUrl(req: http.IncomingMessage, cfg: ServerConfig) {
  const fromOrigin = normalizePublicBaseUrl(req.headers.origin)
  if (fromOrigin) return fromOrigin

  const forwardedBaseUrl = getForwardedBaseUrl(req, cfg)
  if (forwardedBaseUrl) return forwardedBaseUrl

  const referer = normalizeString(req.headers.referer)
  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      /* ignore */
    }
  }

  const host = normalizeString(req.headers.host) ?? `localhost:${cfg.port}`
  return `${cfg.tlsCert ? "https" : "http"}://${host}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function oauthCallbackHtml(title: string, message: string, isError = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #0d1117;
    color: #e6edf3;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  .card {
    width: min(420px, 100%);
    padding: 24px;
    border-radius: 16px;
    background: #161b22;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 24px 60px rgba(0,0,0,0.35);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 20px;
    color: ${isError ? "#ff938a" : "#9be9a8"};
  }
  p { margin: 0; color: #c9d1d9; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <script>setTimeout(() => window.close(), 1200)</script>
</body>
</html>`
}

function getProviderOAuth(provider: string) {
  const oauth = VendorRegistry.getVendorProvider({ id: provider }).getOAuth()
  if (!oauth) {
    throw createApiError(`OAuth is not supported for provider "${provider}"`, API_ERROR_CODES.OAUTH_PROVIDER_UNSUPPORTED)
  }
  return oauth
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
    server.getSession(sessionId)?.state.updateFileSystem()
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
    const session = server.getSession(sessionId)!
    const dir = session.directory
    if (!dir) return
    const target = path.resolve(dir, msg.path || "")
    if (!target.startsWith(path.resolve(dir))) return
    const entries = await listDir(target)
    client.send(JSON.stringify({ type: "ls", path: msg.path || "", entries }))
  }

  if (msg.type === "readFile") {
    const session = server.getSession(sessionId)!
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
    const session = server.getSession(sessionId)
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
  readonly oauthSessions = new Map<string, OAuthSessionRecord>()
  readonly oauthStateIndex = new Map<string, string>()

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
    return this.sessions.get(id)
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

  persistCurrentAccountApiKey(apiKey: string) {
    const normalizedApiKey = normalizeString(apiKey)
    if (!normalizedApiKey) return

    const settings = new SettingsModel(this.readUserSettingsFile())
    const currentAccount = settings.getCurrentAccount()
    if (!currentAccount || normalizeString(currentAccount.API_KEY) === normalizedApiKey) return

    const accounts = settings.accounts.map((account) => (
      account.id === currentAccount.id
        ? { ...account, API_KEY: normalizedApiKey }
        : account
    ))
    const saved = this.writeUserSettingsFile(settings.replaceAccounts(accounts, settings.currentAccountId).toJSON())
    this.applySettingsToConfig(saved)
  }

  private cleanupOAuthSessions() {
    const now = Date.now()
    for (const [sessionId, session] of this.oauthSessions.entries()) {
      if (now - session.createdAt <= OAUTH_SESSION_TTL_MS) continue
      this.oauthSessions.delete(sessionId)
      this.oauthStateIndex.delete(session.state)
    }
  }

  startProviderOAuth(provider: string, publicBaseUrl: string) {
    this.cleanupOAuthSessions()
    const oauth = getProviderOAuth(provider)

    const id = crypto.randomUUID()
    const requestedState = crypto.randomUUID()
    const defaultRedirectUri = `${publicBaseUrl.replace(/\/+$/, "")}/auth/callback`
    const { authUrl, exchangeData, state, redirectUri, captureMode } = oauth.start({
      redirectUri: defaultRedirectUri,
      state: requestedState,
    })
    const effectiveState = state ?? requestedState
    const effectiveRedirectUri = redirectUri ?? defaultRedirectUri
    console.info("[AnyCode][OAuth]", JSON.stringify({ provider, redirectUri: effectiveRedirectUri, authUrl, captureMode: captureMode ?? "callback" }))

    const session: OAuthSessionRecord = {
      id,
      provider,
      state: effectiveState,
      redirectUri: effectiveRedirectUri,
      createdAt: Date.now(),
      status: "pending",
      exchangeData,
    }
    this.oauthSessions.set(id, session)
    this.oauthStateIndex.set(effectiveState, id)

    return {
      sessionId: id,
      authUrl,
      redirectUri: effectiveRedirectUri,
      captureMode: captureMode ?? "callback",
    }
  }

  getProviderOAuthSession(provider: string, sessionId: string) {
    this.cleanupOAuthSessions()
    const session = this.oauthSessions.get(sessionId)
    if (!session || session.provider !== provider) {
      throw createApiError("OAuth session not found", API_ERROR_CODES.OAUTH_SESSION_NOT_FOUND)
    }
    return {
      sessionId: session.id,
      status: session.status,
      apiKey: session.apiKey,
      error: session.error,
    }
  }

  cancelProviderOAuthSession(provider: string, sessionId: string) {
    this.cleanupOAuthSessions()
    const session = this.oauthSessions.get(sessionId)
    if (!session || session.provider !== provider) {
      throw createApiError("OAuth session not found", API_ERROR_CODES.OAUTH_SESSION_NOT_FOUND)
    }
    this.oauthSessions.delete(sessionId)
    this.oauthStateIndex.delete(session.state)
    return { ok: true }
  }

  async completeProviderOAuth(provider: string, params: URLSearchParams) {
    this.cleanupOAuthSessions()

    const state = normalizeString(params.get("state"))
    if (!state) {
      return oauthCallbackHtml("登录失败", "OAuth state is missing.", true)
    }

    const sessionId = this.oauthStateIndex.get(state)
    const session = sessionId ? this.oauthSessions.get(sessionId) : undefined
    if (!session || session.provider !== provider) {
      return oauthCallbackHtml("登录已失效", "This OAuth session was not found or has expired.", true)
    }

    const deniedError = normalizeString(params.get("error"))
    if (deniedError) {
      const description = normalizeString(params.get("error_description")) ?? deniedError
      session.status = "error"
      session.error = description
      return oauthCallbackHtml("登录未完成", description, true)
    }

    if (session.status === "success" && session.apiKey) {
      return oauthCallbackHtml("登录成功", "You can return to AnyCode now.")
    }

    const code = normalizeString(params.get("code"))
    if (!code) {
      session.status = "error"
      session.error = "Authorization code is missing."
      return oauthCallbackHtml("登录失败", session.error, true)
    }

    try {
      const oauth = getProviderOAuth(provider)
      const tokens = await oauth.exchangeCode({
        code,
        state,
        redirectUri: session.redirectUri,
        exchangeData: session.exchangeData,
      })
      session.status = "success"
      session.apiKey = tokens.apiKey
      session.error = undefined
      return oauthCallbackHtml("登录成功", "Token has been captured. Return to AnyCode and continue.")
    } catch (error: any) {
      session.status = "error"
      session.error = error instanceof Error ? error.message : "OAuth exchange failed."
      return oauthCallbackHtml("登录失败", session.error, true)
    }
  }

  async completeProviderOAuthFromState(params: URLSearchParams) {
    this.cleanupOAuthSessions()

    const state = normalizeString(params.get("state"))
    if (!state) {
      return oauthCallbackHtml("登录失败", "OAuth state is missing.", true)
    }

    const sessionId = this.oauthStateIndex.get(state)
    const session = sessionId ? this.oauthSessions.get(sessionId) : undefined
    if (!session) {
      return oauthCallbackHtml("登录已失效", "This OAuth session was not found or has expired.", true)
    }

    return this.completeProviderOAuth(session.provider, params)
  }

  private bindSessionAgentEvents(entry: SessionEntry, chatAgent: IChatAgent) {
    const id = entry.id
    chatAgent.on("directory.set", (data: any) => {
      const dir = data.directory
      entry.directory = dir
      try { chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
      this.db.update("user_session", { op: "eq", field: "session_id", value: id }, { directory: dir })
      console.log(`📂  Session ${id} directory set to: ${dir}`)
      entry.state.updateFileSystem(dir)
      watchDirectory(this, id, dir)
      broadcastAll(this, { type: "windows.updated" })
    })

    chatAgent.on("session.updated", (data: any) => {
      const title = data?.info?.title
      if (title && title !== entry.title) {
        entry.title = title
        broadcastAll(this, { type: "windows.updated" })
      }
    })

    chatAgent.on("cascade.created", (data: any) => {
      this.persistResumeTokenForWindow(id, entry.runtimeAgentType, data?.cascadeId)
    })
  }

  private registerSession(
    id: string,
    chatAgent: IChatAgent,
    directory: string,
    createdAt: number,
    agentType: string,
    runtimeAgentType: string,
  ) {
    const entry: SessionEntry = {
      id,
      chatAgent,
      agentType,
      runtimeAgentType,
      directory,
      createdAt,
      title: "",
      state: new SessionStateModel(this, id),
    }
    this.sessions.set(id, entry)
    entry.state.updateFileSystem(directory)
    this.bindSessionAgentEvents(entry, chatAgent)
    return entry
  }

  private persistResumeTokenForWindow(windowId: string, agentType: string, token: string | undefined) {
    const resumeToken = getUsableResumeToken(agentType, token)
    if (!resumeToken) return
    this.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { cascade_id: resumeToken })
    console.log(`🔗  Window ${windowId} resume token saved: ${resumeToken}`)
  }

  private persistAgentTypeForWindow(windowId: string, agentType: string) {
    this.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { agent_type: agentType })
  }

  async replaceSessionAgent(entry: SessionEntry, keepResumeToken: boolean) {
    const previousAgent = entry.chatAgent
    const row = this.db.findOne("user_session", { op: "eq", field: "session_id", value: entry.id }) as any
    const preferredAgentType = getPreferredAgentType(typeof row?.agent_type === "string" ? row.agent_type : entry.agentType)
    const storedResumeToken = getUsableResumeToken(preferredAgentType, typeof row?.cascade_id === "string" ? row.cascade_id : undefined)
    const liveResumeToken = getUsableResumeToken(entry.runtimeAgentType, tryGetAgentSessionId(previousAgent))
    const shouldKeepResumeToken = !this.cfg.apiKey || keepResumeToken
    const resumeToken = shouldKeepResumeToken ? (storedResumeToken || liveResumeToken) : undefined

    if (!shouldKeepResumeToken) {
      this.db.update("user_session", { op: "eq", field: "session_id", value: entry.id }, { cascade_id: "" })
    }

    const tp = getOrCreateTerminalProvider(this, entry.id)
    const pp = getOrCreatePreviewProvider(this, this.cfg, entry.id)
    const next = await createSessionAgentBinding(this, this.cfg, entry.id, entry.directory, tp, pp, preferredAgentType, resumeToken)

    entry.chatAgent = next.chatAgent
    entry.agentType = next.agentType
    entry.runtimeAgentType = next.runtimeAgentType
    this.persistAgentTypeForWindow(entry.id, entry.agentType)
    this.bindSessionAgentEvents(entry, next.chatAgent)

    if (entry.directory) {
      try { next.chatAgent.setWorkingDirectory(entry.directory) } catch { /* ignore */ }
      watchDirectory(this, entry.id, entry.directory)
    }

    this.persistResumeTokenForWindow(entry.id, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    await destroyChatAgent(previousAgent)
  }

  async applyAgentSwitchToSessions() {
    const entries = Array.from(this.sessions.values())
    for (const entry of entries) {
      this.sessionChatAbort.get(entry.id)?.()
      this.sessionChatAbort.delete(entry.id)
      entry.state.setChatBusy(false)
      await this.replaceSessionAgent(entry, !this.cfg.apiKey || entry.agentType === this.cfg.agent)
    }
  }

  async resumeSession(row: Record<string, unknown>): Promise<SessionEntry> {
    const sessionId = row.session_id as string
    const cached = this.sessions.get(sessionId)
    if (cached) return cached

    const dir = (row.directory as string) || ""
    const preferredAgentType = getPreferredAgentType(typeof row.agent_type === "string" ? row.agent_type : this.cfg.agent)
    const resumeToken = getUsableResumeToken(preferredAgentType, (row.cascade_id as string) || undefined)
    console.log(`♻️  Resuming session ${sessionId}, resume_token=${resumeToken || '(none)'}, dir=${dir || '(none)'}`)
    const tp = getOrCreateTerminalProvider(this, sessionId)
    const pp = getOrCreatePreviewProvider(this, this.cfg, sessionId)
    const next = await createSessionAgentBinding(this, this.cfg, sessionId, dir, tp, pp, preferredAgentType, resumeToken)

    const entry = this.registerSession(sessionId, next.chatAgent, dir, row.time_created as number, next.agentType, next.runtimeAgentType)
    this.persistAgentTypeForWindow(sessionId, entry.agentType)
    if (dir) {
      try { next.chatAgent.setWorkingDirectory(dir) } catch { /* already set */ }
      watchDirectory(this, sessionId, dir)
    }
    this.persistResumeTokenForWindow(sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    console.log(`♻️  Session ${sessionId} resumed`)
    return entry
  }

  async createNewWindow(isDefault = false): Promise<SessionEntry> {
    const sessionId = crypto.randomUUID()
    const tp = getOrCreateTerminalProvider(this, sessionId)
    const pp = getOrCreatePreviewProvider(this, this.cfg, sessionId)
    const next = await createSessionAgentBinding(this, this.cfg, sessionId, "", tp, pp, getPreferredAgentType(this.cfg.agent))
    const now = Date.now()
    ; (tp as any).sessionId = sessionId
    ; (pp as any).sessionId = sessionId
    const entry = this.registerSession(sessionId, next.chatAgent, "", now, next.agentType, next.runtimeAgentType)

    this.db.insert("user_session", {
      session_id: sessionId,
      directory: "",
      time_created: now,
      is_default: isDefault ? 1 : 0,
      cascade_id: "",
      agent_type: entry.agentType,
    })

    this.persistResumeTokenForWindow(sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    console.log(`✅  Window ${sessionId} created${isDefault ? " (default)" : ""}`)
    return entry
  }

  async getOrCreateSession(): Promise<SessionEntry> {
    const rows = this.db.findMany("user_session", {})
    const defaultRow = rows.find((r: any) => r.is_default === 1) || rows[0]

    if (defaultRow) {
      if (defaultRow.is_default !== 1) {
        this.db.update("user_session", { op: "eq", field: "session_id", value: defaultRow.session_id }, { is_default: 1 })
      }
      return this.resumeSession(defaultRow)
    }

    return this.createNewWindow(true)
  }

  async getAllWindows(): Promise<SessionEntry[]> {
    const rows = this.db.findMany("user_session", {})
    if (rows.length === 0) {
      return [await this.createNewWindow(true)]
    }
    const entries: SessionEntry[] = []
    for (const row of rows) {
      entries.push(await this.resumeSession(row))
    }
    return entries
  }

  async deleteWindow(sessionId: string): Promise<boolean> {
    const row = this.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
    if (!row) return false
    if ((row as any).is_default === 1) return false

    this.sessionChatAbort.get(sessionId)?.()
    this.sessionChatAbort.delete(sessionId)

    const statePushTimer = this.statePushTimers.get(sessionId)
    if (statePushTimer) {
      clearTimeout(statePushTimer)
      this.statePushTimers.delete(sessionId)
    }

    const watcher = this.dirWatchManagers.get(sessionId)
    if (watcher) {
      watcher.destroy()
      this.dirWatchManagers.delete(sessionId)
    }

    const session = this.sessions.get(sessionId)
    if (session) {
      this.sessions.delete(sessionId)
      await destroyChatAgent(session.chatAgent)
    }

    const tp = this.terminalProviders.get(sessionId)
    if (tp && tp.exists()) {
      try { tp.teardown() } catch { /* ignore */ }
    }
    this.terminalProviders.delete(sessionId)
    this.previewProviders.delete(sessionId)
    this.sessionClients.delete(sessionId)

    if (this.previewSessionId === sessionId) {
      this.previewSessionId = null
      this.previewTarget = null
    }

    this.db.remove("user_session", { op: "eq", field: "session_id", value: sessionId })
    this.db.remove("user_session_message", { op: "eq", field: "session_id", value: sessionId })
    console.log(`🗑  Window ${sessionId} deleted`)
    return true
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
    if (req.method === "GET" && !req.url?.startsWith("/api/") && !req.url?.startsWith("/admin") && !req.url?.startsWith("/auth/")) {
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

    const oauthStartMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/start$/)
    if (req.method === "POST" && oauthStartMatch) {
      const body = await readJsonBody(req)
      const publicBaseUrl = normalizePublicBaseUrl(body.publicBaseUrl) ?? getRequestBaseUrl(req, cfg)
      try {
        const oauth = server.startProviderOAuth(oauthStartMatch[1], publicBaseUrl)
        sendJson(res, 200, oauth)
      } catch (error) {
        sendErrorJson(res, 400, error, "Failed to start OAuth")
      }
      return
    }

    const oauthSessionMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/sessions\/([^/?]+)$/)
    if (req.method === "GET" && oauthSessionMatch) {
      try {
        sendJson(res, 200, server.getProviderOAuthSession(oauthSessionMatch[1], oauthSessionMatch[2]))
      } catch (error) {
        sendErrorJson(res, 404, error, "OAuth session not found")
      }
      return
    }

    if (req.method === "DELETE" && oauthSessionMatch) {
      try {
        sendJson(res, 200, server.cancelProviderOAuthSession(oauthSessionMatch[1], oauthSessionMatch[2]))
      } catch (error) {
        sendErrorJson(res, 404, error, "OAuth session not found")
      }
      return
    }

    const oauthCallbackMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/callback(?:\?|$)/)
    if (req.method === "GET" && oauthCallbackMatch) {
      const url = new URL(req.url!, `${cfg.tlsCert ? "https" : "http"}://localhost:${cfg.port}`)
      const html = await server.completeProviderOAuth(oauthCallbackMatch[1], url.searchParams)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
      return
    }

    if (req.method === "GET" && req.url?.match(/^\/auth\/callback(?:\?|$)/)) {
      const url = new URL(req.url!, `${cfg.tlsCert ? "https" : "http"}://localhost:${cfg.port}`)
      const html = await server.completeProviderOAuthFromState(url.searchParams)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(html)
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

      const duplicateAccountName = getDuplicateAccountName(rawAccounts as Array<Record<string, unknown>>)
      if (duplicateAccountName) {
        sendJson(res, 400, {
          error: `Account name "${duplicateAccountName}" already exists`,
          code: API_ERROR_CODES.SETTINGS_ACCOUNT_NAME_DUPLICATE,
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
        const saved = server.writeUserSettingsFile(next)
        server.applySettingsToConfig(saved)
        await server.applyAgentSwitchToSessions()
      } catch (err: any) {
        server.writeUserSettingsFile(previous)
        server.applySettingsToConfig(previous)
        try {
          await server.applyAgentSwitchToSessions()
        } catch (rollbackErr) {
          console.error("⚠  Failed to roll back account switch:", rollbackErr)
        }
        sendErrorJson(res, 500, err, "Failed to save settings")
        return
      }

      const saved = server.readUserSettingsFile()
      sendJson(res, 200, {
        ok: true,
        accounts: saved.accounts ?? [],
        currentAccountId: saved.currentAccountId ?? null,
      })
      return
    }

    // ── Session management ──
    if (req.method === "POST" && req.url === "/api/sessions") {
      server.getOrCreateSession().then((entry) => {
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
      server.getAllWindows().then(async (entries) => {
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
      server.createNewWindow(false).then((entry) => {
        sendJson(res, 200, { id: entry.id, directory: entry.directory, isDefault: false })
      }).catch((err: any) => {
        sendErrorJson(res, 500, err)
      })
      return
    }

    // DELETE /api/windows/:id — delete non-default window
    const windowDeleteMatch = req.url?.match(/^\/api\/windows\/([^/?]+)$/)
    if (req.method === "DELETE" && windowDeleteMatch) {
      server.deleteWindow(windowDeleteMatch[1]).then((ok) => {
        if (ok) {
          sendJson(res, 200, { ok: true })
        } else {
          sendJson(res, 400, { error: "Cannot delete default window or window not found" })
        }
      }).catch((err: any) => {
        sendErrorJson(res, 500, err, "Failed to delete window")
      })
      return
    }

    // GET|POST /api/sessions/:id/...
    const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/?]+)(?:\/([a-z]+))?/)
    if ((req.method === "GET" || req.method === "POST") && sessionMatch) {
      const session = server.getSession(sessionMatch[1])
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
      let session = sessionId ? server.getSession(sessionId) : undefined

      // Session may not be in memory after server restart — try resuming from DB
      if (!session && sessionId) {
        const row = server.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
        if (row) {
          try {
            session = await server.resumeSession(row as Record<string, unknown>)
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
