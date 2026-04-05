/**
 * @any-code/server — API server for CodeAgent
 *
 * Runtime config comes from ~/.anycode/settings.json.
 * Process env is only used for server-level flags like PORT/TLS.
 */

import http from "http"
import path from "path"
import os from "os"
import fs from "fs"
import { spawn as cpSpawn } from "child_process"
import { CodeAgent, type NoSqlDb } from "@any-code/agent"
import { WebSocketServer, WebSocket as WS } from "ws"
import { SqlJsStorage, NodeFS, NodeSearchProvider, consoleLogger } from "@any-code/utils"
import { SettingsStore } from "@any-code/settings"
import { NodeGitProvider } from "./git"
import { createPreviewServer, type NodePreviewProvider } from "./preview"
import { createMainServer, resolveAppDist } from "./http"
import { ServerAccountsManager } from "./accounts"
import { SessionManager, type ClientLike, type SessionEntry } from "./session-manager"
import { DirectoryWatchManager } from "./session-state"
import { NodeTerminalProvider } from "./terminal"

const DEFAULT_ANYCODE_DIR = path.join(os.homedir(), ".anycode")

export interface ServerConfig {
  provider: string
  model: string
  reasoningEffort?: string
  serviceTier?: string
  apiKey: string
  baseUrl: string
  port: number
  previewPort: number
  appDist: string
  userSettings: Record<string, any>
  tlsCert?: string
  tlsKey?: string
  agent: string
}

export interface AnyCodeServerOptions {
  config?: ServerConfig
  anycodeDir?: string
  dbPath?: string
  settingsStore?: SettingsStore
}

function ensureDataPath(anycodeDir: string) {
  const dataPath = path.join(anycodeDir, "data")
  fs.mkdirSync(dataPath, { recursive: true })
  return dataPath
}

class NodeShellProvider {
  platform = process.platform
  private shell: string

  constructor() {
    const currentShell = process.env.SHELL
    const BLACKLIST = new Set(["fish", "nu"])
    if (currentShell && !BLACKLIST.has(path.basename(currentShell))) {
      this.shell = currentShell
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
      await new Promise((resolve) => setTimeout(resolve, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) process.kill(-pid, "SIGKILL")
    } catch {
      proc.kill("SIGTERM")
      await new Promise((resolve) => setTimeout(resolve, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) proc.kill("SIGKILL")
    }
  }
}

export class AnyCodeServer {
  readonly anycodeDir: string
  readonly dbPath: string
  readonly settingsStore: SettingsStore
  readonly gitProvider = new NodeGitProvider()

  readonly NodeFS = NodeFS
  readonly NodeSearchProvider = NodeSearchProvider
  readonly NodeShellProvider = NodeShellProvider
  readonly consoleLogger = consoleLogger

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

  readonly accounts: ServerAccountsManager
  readonly sessionManager: SessionManager

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
    this.accounts = new ServerAccountsManager(this)
    this.sessionManager = new SessionManager(this)
  }

  makePaths(anycodeDir = this.anycodeDir) {
    return ensureDataPath(anycodeDir)
  }

  getSession(id: string) {
    return this.sessionManager.getSession(id)
  }

  getSessionClients(sessionId: string) {
    return this.sessionManager.getSessionClients(sessionId)
  }

  scheduleStatePush(sessionId: string, delayMs = 300) {
    this.sessionManager.scheduleStatePush(sessionId, delayMs)
  }

  getPreviewPortForSession(sessionId: string) {
    return this.previewSessionId === sessionId && this.previewTarget ? this.cfg.previewPort : null
  }

  getPreviewPathForSession(sessionId: string) {
    if (this.previewSessionId !== sessionId || !this.previewTarget) return null

    try {
      const target = new URL(this.previewTarget)
      return `${target.pathname || "/"}${target.search || ""}` || "/"
    } catch {
      return "/"
    }
  }

  setPreviewTarget(sessionId: string, forwardedLocalUrl: string) {
    const previousSessionId = this.previewSessionId

    try {
      const next = new URL(forwardedLocalUrl)
      if (next.hostname === "localhost") next.hostname = "127.0.0.1"
      next.hash = ""
      this.previewTarget = next.toString()
    } catch {
      this.previewTarget = forwardedLocalUrl.replace(/\/+$/, "")
    }
    this.previewSessionId = sessionId
    if (previousSessionId && previousSessionId !== sessionId) {
      this.getSession(previousSessionId)?.state.setPreview(null, null)
    }
    return this.previewTarget
  }

  private loadConfig(): ServerConfig {
    const runtime = this.settingsStore.read().resolveRuntime()
    const port = parseInt(process.env.PORT ?? "3210", 10)
    const previewPort = parseInt(process.env.PREVIEW_PORT ?? String(port + 1), 10)
    if (!runtime.provider) {
      console.error("❌  Missing PROVIDER")
      process.exit(1)
    }
    const tlsCert = process.env.TLS_CERT ?? runtime.userSettings.TLS_CERT ?? undefined
    const tlsKey = process.env.TLS_KEY ?? runtime.userSettings.TLS_KEY ?? undefined
    if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
      console.error("❌  Both TLS_CERT and TLS_KEY must be set together")
      process.exit(1)
    }
    return {
      provider: runtime.provider,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
      serviceTier: runtime.serviceTier,
      apiKey: runtime.apiKey,
      baseUrl: runtime.baseUrl,
      port,
      previewPort,
      appDist: resolveAppDist(),
      userSettings: runtime.userSettings,
      tlsCert,
      tlsKey,
      agent: runtime.agent,
    }
  }

  private registerProcessErrorHandlers() {
    process.on("uncaughtException", (error) => {
      console.error("⚠  Uncaught exception:", error.message)
    })
    process.on("unhandledRejection", (reason) => {
      console.error("⚠  Unhandled rejection:", reason instanceof Error ? reason.message : reason)
    })
  }

  private async initializeStorage() {
    this.sharedStorage = new SqlJsStorage(this.dbPath)
    this.db = await this.sharedStorage.connect()

    const columns = this.sharedStorage.query(`PRAGMA table_info("user_session")`)
    if (columns.length > 0) {
      const hasIsDefault = columns.some((column: any) => column.name === "is_default")
      const hasUserId = columns.some((column: any) => column.name === "user_id")
      const primaryKeyColumn = columns.find((column: any) => column.pk === 1)
      const needsPkMigration = primaryKeyColumn && primaryKeyColumn.name === "user_id"
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

      if (!columns.some((column: any) => column.name === "cascade_id")) {
        this.sharedStorage.exec(`ALTER TABLE "user_session" ADD COLUMN "cascade_id" TEXT NOT NULL DEFAULT ''`)
        console.log("✅  Added cascade_id column to user_session")
      }
      if (!columns.some((column: any) => column.name === "agent_type")) {
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
      aliveSet.add(ws)
      ws.on("pong", () => aliveSet.add(ws))
      this.sessionManager.handleWebSocketConnection(ws, req, this.cfg.port)
    })

    const host = process.env.HOST ?? "0.0.0.0"
    const proto = this.cfg.tlsCert ? "https" : "http"
    const wsProto = this.cfg.tlsCert ? "wss" : "ws"

    this.previewServer.listen(this.cfg.previewPort, host, () => {
      console.log(`👁  Preview proxy: ${proto}://${host}:${this.cfg.previewPort}`)
    })

    this.mainServer.listen(this.cfg.port, host, () => {
      console.log(`🌐  ${proto}://${host}:${this.cfg.port}`)
      console.log(`🤖  Provider: ${this.cfg.provider} / ${this.cfg.model}`)
      console.log(`🖥  Admin: ${proto}://${host}:${this.cfg.port}/admin`)
      if (this.appDistExists) {
        console.log(`📱  App: ${proto}://${host}:${this.cfg.port}`)
      } else {
        console.log(`⚠  App dist not found at ${this.cfg.appDist} — run 'pnpm --filter @any-code/app build' first`)
      }
      console.log("📋  Sessions: POST /api/sessions to create")
      console.log(`🔌  WebSocket: ${wsProto}://${host}:${this.cfg.port}?sessionId=xxx`)
      if (this.cfg.tlsCert) console.log("🔒  TLS enabled")
    })

    return this
  }
}

export async function startServer() {
  return new AnyCodeServer().start()
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider }
export type { VirtualFileSystem, StorageProvider, Migration } from "@any-code/utils"
