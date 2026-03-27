// ── Schema ──────────────────────────────────────────────────────────────────

import type { Brand } from "../util/schema"
import type { AgentContext } from "../context"
import * as path from "../util/path"
import { Flag } from "../util/flag"
import { Glob } from "../util/glob"

export type ProjectID = Brand<string, "ProjectID">

export const ProjectID = {
  global: "global" as ProjectID,
  make: (id: string) => id as ProjectID,
}

// ── Protected ───────────────────────────────────────────────────────────────

const DARWIN_HOME = [
  "Music", "Pictures", "Movies", "Downloads", "Desktop", "Documents",
  "Public", "Applications", "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook", "Calendars", "Mail", "Messages",
  "Safari", "Cookies", "Application Support/com.apple.TCC",
  "PersonalizationPortrait", "Metadata/CoreSpotlight", "Suggestions",
]

const DARWIN_ROOT = ["/. DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]
const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

export namespace Protected {
  export function names(platform: string): ReadonlySet<string> {
    if (platform === "darwin") return new Set(DARWIN_HOME)
    if (platform === "win32") return new Set(WIN32_HOME)
    return new Set()
  }

  export function paths(home: string, platform: string): string[] {
    if (platform === "darwin")
      return [
        ...DARWIN_HOME.map((n) => path.join(home, n)),
        ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
        ...DARWIN_ROOT,
      ]
    if (platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
    return []
  }
}

// ── FileIgnore ──────────────────────────────────────────────────────────────

export namespace FileIgnore {
  const FOLDERS = new Set([
    "node_modules", "bower_components", ".pnpm-store", "vendor", ".npm",
    "dist", "build", "out", ".next", "target", "bin", "obj",
    ".git", ".svn", ".hg", ".vscode", ".idea", ".turbo", ".output",
    "desktop", ".sst", ".cache", ".webkit-cache",
    "__pycache__", ".pytest_cache", "mypy_cache", ".history", ".gradle",
  ])

  const FILES = [
    "**/*.swp", "**/*.swo", "**/*.pyc",
    "**/.DS_Store", "**/Thumbs.db",
    "**/logs/**", "**/tmp/**", "**/temp/**", "**/*.log",
    "**/coverage/**", "**/.nyc_output/**",
  ]

  export const PATTERNS = [...FILES, ...FOLDERS]

  export function match(
    filepath: string,
    opts?: { extra?: string[]; whitelist?: string[] },
  ) {
    for (const pattern of opts?.whitelist || []) {
      if (Glob.match(pattern, filepath)) return false
    }
    const parts = filepath.split(/[/\\]/)
    for (let i = 0; i < parts.length; i++) {
      if (FOLDERS.has(parts[i])) return true
    }
    const extra = opts?.extra || []
    for (const pattern of [...FILES, ...extra]) {
      if (Glob.match(pattern, filepath)) return true
    }
    return false
  }
}

// ── FileTime ────────────────────────────────────────────────────────────────

export class FileTimeService {
  private readTimes: { [sessionID: string]: { [path: string]: Date | undefined } } = {}
  private locks = new Map<string, Promise<void>>()

  read(sessionID: string, file: string) {
    this.readTimes[sessionID] = this.readTimes[sessionID] || {}
    this.readTimes[sessionID][file] = new Date()
  }

  get(sessionID: string, file: string) {
    return this.readTimes[sessionID]?.[file]
  }

  async assert(context: AgentContext, sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) return
    const time = this.get(sessionID, filepath)
    if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const s = await context.fs.stat(filepath)
    const mtimeMs = s?.mtimeMs
    if (mtimeMs && mtimeMs > time.getTime() + 50) {
      const mtime = new Date(mtimeMs)
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${mtime.toISOString()}\nLast read: ${time.toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
  }

  async withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => { release = resolve })
    const chained = currentLock.then(() => nextLock)
    this.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(filepath) === chained) this.locks.delete(filepath)
    }
  }
}


// ── Project ─────────────────────────────────────────────────────────────────

export namespace Project {
  export interface Info {
    id: ProjectID
    worktree: string
    vcs?: "git"
    name?: string
    icon?: {
      url?: string
      override?: string
      color?: string
    }
    commands?: {
      /** Startup script to run when creating a new workspace (worktree) */
      start?: string
    }
    time: {
      created: number
      updated: number
      initialized?: number
    }
    sandboxes: string[]
  }
}