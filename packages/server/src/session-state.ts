import fs from "fs"
import path from "path"
import { WebSocket as WS } from "ws"
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar"
import type { AnyCodeServer } from "./index"
import { getGitChanges, listDir } from "./filesystem"

export class DirectoryWatchManager {
  private watchers = new Map<string, ChokidarWatcher>()
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private gitTimer: ReturnType<typeof setTimeout> | undefined
  private pendingDirs = new Set<string>()

  constructor(
    private readonly server: AnyCodeServer,
    private readonly sessionId: string,
    private readonly rootDir: string,
  ) {
    if (rootDir) {
      this.watchDir("")
      this.watchGitDir()
    }
  }

  private watchGitDir() {
    const gitDir = path.join(this.rootDir, ".git")
    try {
      fs.accessSync(gitDir)
    } catch {
      return
    }

    const gitWatcher = chokidarWatch(gitDir, {
      ignored: /(objects|logs|hooks|info)/,
      ignoreInitial: true,
      depth: 2,
      usePolling: true,
      interval: 3000,
    })

    gitWatcher.on("all", () => {
      if (this.gitTimer) return
      this.gitTimer = setTimeout(() => {
        this.gitTimer = undefined
        this.server.scheduleStatePush(this.sessionId, 0)
      }, 500)
    })
    gitWatcher.on("error", () => {})
    this.watchers.set("__git__", gitWatcher)
  }

  watchDir(relPath: string) {
    if (this.watchers.has(relPath)) return
    const absPath = relPath ? path.join(this.rootDir, relPath) : this.rootDir

    const watcher = chokidarWatch(absPath, {
      ignored: /(^|[\/\\])(\.git|node_modules)([\/\\]|$)/,
      ignoreInitial: true,
      depth: 0,
      usePolling: true,
      interval: 3000,
    })

    watcher.on("all", () => {
      this.pendingDirs.add(relPath)
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flush(), 500)
      }
    })
    watcher.on("error", (err) => console.error(`❌  watch error ${absPath}:`, err))

    this.watchers.set(relPath, watcher)
  }

  unwatchDir(relPath: string) {
    if (relPath === "") return
    const watcher = this.watchers.get(relPath)
    if (watcher) {
      watcher.close()
      this.watchers.delete(relPath)
    }
  }

  private flush() {
    this.batchTimer = undefined
    if (this.pendingDirs.size === 0) return
    const dirs = [...this.pendingDirs]
    this.pendingDirs = new Set()

    const clients = this.server.getSessionClients(this.sessionId)
    const msg = JSON.stringify({ type: "fs.changed", dirs })
    for (const client of clients) {
      if (client.readyState === WS.OPEN) client.send(msg)
    }

    this.server.scheduleStatePush(this.sessionId, 0)
  }

  destroy() {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}

export function watchDirectory(server: AnyCodeServer, sessionId: string, dir: string) {
  const existing = server.dirWatchManagers.get(sessionId)
  if (existing) {
    existing.destroy()
    server.dirWatchManagers.delete(sessionId)
  }

  if (!dir) return

  const manager = new DirectoryWatchManager(server, sessionId, dir)
  server.dirWatchManagers.set(sessionId, manager)
  console.log(`👁  Watching directory: ${dir}`)
}

export class SessionStateModel {
  directory = ""
  topLevel: any[] = []
  changes: any[] = []
  previewPort: number | null = null
  previewPath: string | null = null
  chatBusy = false
  contextUsed = 0
  compactionThreshold = 0

  private isComputing = false
  private needsCompute = false

  constructor(
    private readonly server: AnyCodeServer,
    private readonly sessionId: string,
  ) {}

  async updateFileSystem(dir?: string) {
    if (dir !== undefined && this.directory !== dir) {
      this.directory = dir
      this.topLevel = []
      this.changes = []
    }

    const expectedPort = this.server.getPreviewPortForSession(this.sessionId)
    const expectedPath = this.server.getPreviewPathForSession(this.sessionId)
    if (this.previewPort !== expectedPort || this.previewPath !== expectedPath) {
      this.previewPort = expectedPort
      this.previewPath = expectedPath
    }

    if (this.isComputing) {
      this.needsCompute = true
      return
    }

    this.isComputing = true
    try {
      do {
        this.needsCompute = false
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
      } while (this.needsCompute)
    } catch (err) {
      console.error("❌ SessionStateModel compute error:", err)
    } finally {
      this.isComputing = false
    }
  }

  setPreview(port: number | null, path: string | null) {
    if (this.previewPort !== port || this.previewPath !== path) {
      this.previewPort = port
      this.previewPath = path
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
      previewPath: this.previewPath,
      chatBusy: this.chatBusy,
      contextUsed: this.contextUsed,
      compactionThreshold: this.compactionThreshold,
    }
  }

  notify() {
    const json = JSON.stringify(this.toJSON())
    const clients = this.server.getSessionClients(this.sessionId)
    console.log(`📤  SessionStateModel(${this.sessionId}): dir="${this.directory}", topLevel=${this.topLevel.length} entries, changes=${this.changes.length}, previewPort=${this.previewPort}, previewPath=${this.previewPath}, clients=${clients.size}`)
    for (const client of clients) {
      if (client.readyState === WS.OPEN) client.send(json)
    }
  }
}
