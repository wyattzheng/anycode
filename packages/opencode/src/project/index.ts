// ── Schema ──────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import z from "zod"
import { withStatics } from "@/util/schema"
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage"
import type { AgentContext } from "@/context"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import os from "os"
import { Log } from "@/util/log"
import { Flag } from "@/util/flag"
import { fn } from "@/util/fn"
import { BusEvent } from "@/bus"
import { Bus } from "@/bus"
import { iife } from "@/util/fn"
import { GlobalBus } from "@/bus"
import { Glob } from "@/util/glob"
import { which } from "@/util/which"



const projectIdSchema = Schema.String.pipe(Schema.brand("ProjectID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.makeUnsafe("global"),
    make: (id: string) => schema.makeUnsafe(id),
    zod: z.string().pipe(z.custom<ProjectID>()),
  })),
)

// ── ProjectTable (SQL) ──────────────────────────────────────────────────────

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

// ── Protected ───────────────────────────────────────────────────────────────

const home = os.homedir()

const DARWIN_HOME = [
  "Music", "Pictures", "Movies", "Downloads", "Desktop", "Documents",
  "Public", "Applications", "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook", "Calendars", "Mail", "Messages",
  "Safari", "Cookies", "Application Support/com.apple.TCC",
  "PersonalizationPortrait", "Metadata/CoreSpotlight", "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]
const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

export namespace Protected {
  export function names(): ReadonlySet<string> {
    if (process.platform === "darwin") return new Set(DARWIN_HOME)
    if (process.platform === "win32") return new Set(WIN32_HOME)
    return new Set()
  }

  export function paths(): string[] {
    if (process.platform === "darwin")
      return [
        ...DARWIN_HOME.map((n) => path.join(home, n)),
        ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
        ...DARWIN_ROOT,
      ]
    if (process.platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
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
  private log = Log.create({ service: "file.time" })
  private readTimes: { [sessionID: string]: { [path: string]: Date | undefined } } = {}
  private locks = new Map<string, Promise<void>>()

  read(sessionID: string, file: string) {
    this.log.info("read", { sessionID, file })
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
    const s = await Filesystem.stat(context, filepath)
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

export namespace FileTime {
  function svc(context: AgentContext) {
    if (context.fileTime) return context.fileTime
    return context.fileTime
  }

  export function state(context: AgentContext) {
    const s = svc(context)
    return { read: (s as any).readTimes, locks: (s as any).locks }
  }

  export function read(context: AgentContext, sessionID: string, file: string) {
    svc(context).read(sessionID, file)
  }

  export function get(context: AgentContext, sessionID: string, file: string) {
    return svc(context).get(sessionID, file)
  }

  export async function withLock<T>(context: AgentContext, filepath: string, fn: () => Promise<T>): Promise<T> {
    return svc(context).withLock(filepath, fn)
  }

  export async function assert(context: AgentContext, sessionID: string, filepath: string) {
    return svc(context).assert(context, sessionID, filepath)
  }
}




// ── Project ─────────────────────────────────────────────────────────────────

export namespace Project {
  const log = Log.create({ service: "project" })

  function gitpath(cwd: string, name: string) {
    if (!name) return cwd
    name = name.replace(/[\r\n]+$/, "")
    if (!name) return cwd
    name = Filesystem.windowsPath(name)
    if (path.isAbsolute(name)) return path.normalize(name)
    return path.resolve(cwd, name)
  }

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({ ref: "Project" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  type Row = Record<string, any>

  export function fromRow(row: Row): Info {
    const icon =
      row.icon_url || row.icon_color
        ? { url: row.icon_url ?? undefined, color: row.icon_color ?? undefined }
        : undefined
    return {
      id: ProjectID.make(row.id),
      worktree: row.worktree,
      vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
      name: row.name ?? undefined,
      icon,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        initialized: row.time_initialized ?? undefined,
      },
      sandboxes: row.sandboxes,
      commands: row.commands ?? undefined,
    }
  }

  function readCachedId(context: AgentContext, dir: string) {
    return Filesystem.readText(context, path.join(dir, "opencode"))
      .then((x) => x.trim())
      .then(ProjectID.make)
      .catch(() => undefined)
  }

  export async function fromDirectory(context: AgentContext, directory: string) {
    log.info("fromDirectory", { directory })

    const data = await iife(async () => {
      const matches = Filesystem.up(context, { targets: [".git"], start: directory })
      const dotgit = await matches.next().then((x) => x.value)
      await matches.return()
      if (dotgit) {
        let sandbox = path.dirname(dotgit)
        const gitBinary = which("git")
        let id = await readCachedId(context, dotgit)

        if (!gitBinary) {
          return { id: id ?? ProjectID.global, worktree: sandbox, sandbox, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }
        }

        const worktree = await context.git.run(["rev-parse", "--git-common-dir"], { cwd: sandbox })
          .then(async (result: any) => {
            const common = gitpath(sandbox, result.text())
            return common === sandbox ? sandbox : path.dirname(common)
          })
          .catch(() => undefined)

        if (!worktree) {
          return { id: id ?? ProjectID.global, worktree: sandbox, sandbox, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }
        }

        if (id == null) {
          id = await readCachedId(context, path.join(worktree, ".git"))
        }

        if (!id) {
          const roots = await context.git.run(["rev-list", "--max-parents=0", "HEAD"], { cwd: sandbox })
            .then(async (result: any) =>
              result.text().split("\n").filter(Boolean).map((x: string) => x.trim()).toSorted(),
            )
            .catch(() => undefined)

          if (!roots) {
            return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }
          }

          id = roots[0] ? ProjectID.make(roots[0]) : undefined
          if (id) {
            await Filesystem.write(context, path.join(worktree, ".git", "opencode"), id).catch(() => undefined)
          }
        }

        if (!id) {
          return { id: ProjectID.global, worktree: sandbox, sandbox, vcs: "git" }
        }

        const top = await context.git.run(["rev-parse", "--show-toplevel"], { cwd: sandbox })
          .then(async (result: any) => gitpath(sandbox, result.text()))
          .catch(() => undefined)

        if (!top) {
          return { id, worktree: sandbox, sandbox, vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }
        }

        sandbox = top
        return { id, sandbox, worktree, vcs: "git" }
      }

      return { id: ProjectID.global, worktree: "/", sandbox: "/", vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS) }
    })

    const row = context.db.findOne("project", { op: "eq", field: "id", value: data.id })
    const existing = row
      ? fromRow(row)
      : {
          id: data.id,
          worktree: data.worktree,
          vcs: data.vcs as Info["vcs"],
          sandboxes: [] as string[],
          time: { created: Date.now(), updated: Date.now() },
        }

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(context, existing)

    const result: Info = {
      ...existing,
      worktree: data.worktree,
      vcs: data.vcs as Info["vcs"],
      time: { ...existing.time, updated: Date.now() },
    }
    if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
      result.sandboxes.push(data.sandbox)
    result.sandboxes = (await Promise.all(result.sandboxes.map(async (x) => ({ x, exists: await Filesystem.exists(context, x) })))).filter(r => r.exists).map(r => r.x)
    const insert = {
      id: result.id, worktree: result.worktree, vcs: result.vcs ?? null,
      name: result.name, icon_url: result.icon?.url, icon_color: result.icon?.color,
      time_created: result.time.created, time_updated: result.time.updated,
      time_initialized: result.time.initialized, sandboxes: result.sandboxes, commands: result.commands,
    }
    const updateSet = {
      worktree: result.worktree, vcs: result.vcs ?? null,
      name: result.name, icon_url: result.icon?.url, icon_color: result.icon?.color,
      time_updated: result.time.updated, time_initialized: result.time.initialized,
      sandboxes: result.sandboxes, commands: result.commands,
    }
    context.db.upsert("project", insert, ["id"], updateSet)
    
    if (data.id !== ProjectID.global) {
      context.db.update("session",
        { op: "and", conditions: [{ op: "eq", field: "project_id", value: ProjectID.global }, { op: "eq", field: "directory", value: data.worktree }] },
        { project_id: data.id },
      )
    }
    GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: result } })
    return { project: result, sandbox: data.sandbox }
  }

  export async function discover(context: AgentContext, input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const matches = await Glob.scan(context, "**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
      cwd: input.worktree, absolute: true, include: "file",
    })
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const buffer = await Filesystem.readBytes(context, shortest)
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = Filesystem.mimeType(shortest) || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update(context, { projectID: input.id, icon: { url } })
  }

  export function setInitialized(context: AgentContext, id: ProjectID) {
    context.db.update("project", { op: "eq", field: "id", value: id }, { time_initialized: Date.now() })
  }

  export function list(context: AgentContext) {
    return context.db.findMany("project").map((row: any) => fromRow(row))
  }

  export function get(context: AgentContext, id: ProjectID): Info | undefined {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) return undefined
    return fromRow(row)
  }

  export async function initGit(context: AgentContext, input: { directory: string; project: Info }) {
    if (input.project.vcs === "git") return input.project
    if (!which("git")) throw new Error("Git is not installed")
    const result = await context.git.run(["init", "--quiet"], { cwd: input.directory })
    if (result.exitCode !== 0) {
      const text = result.stderr.toString().trim() || result.text().trim()
      throw new Error(text || "Failed to initialize git repository")
    }
    return (await fromDirectory(context, input.directory)).project
  }

  export async function update(context: AgentContext, input: { projectID: any; name?: string; icon?: any; commands?: any }) {
    const id = ProjectID.make(input.projectID)
    const result = context.db.update("project",
      { op: "eq", field: "id", value: id },
      { name: input.name, icon_url: input.icon?.url, icon_color: input.icon?.color, commands: input.commands, time_updated: Date.now() },
    )
    if (!result) throw new Error(`Project not found: ${input.projectID}`)
    const data = fromRow(result)
    GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: data } })
    return data
  }

  export async function sandboxes(context: AgentContext, id: ProjectID) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) return []
    const data = fromRow(row)
    const valid: string[] = []
    for (const dir of data.sandboxes) {
      const s = await Filesystem.stat(context, dir)
      if (s?.isDirectory) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(context: AgentContext, id: ProjectID, directory: string) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = [...row.sandboxes]
    if (!sandboxes.includes(directory)) sandboxes.push(directory)
    const result = context.db.update("project", { op: "eq", field: "id", value: id }, { sandboxes, time_updated: Date.now() })
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: data } })
    return data
  }

  export async function removeSandbox(context: AgentContext, id: ProjectID, directory: string) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = row.sandboxes.filter((s: any) => s !== directory)
    const result = context.db.update("project", { op: "eq", field: "id", value: id }, { sandboxes, time_updated: Date.now() })
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", { payload: { type: Event.Updated.type, properties: data } })
    return data
  }
}


// ── File ────────────────────────────────────────────────────────────────────

export namespace File {
  export const Event = {
    Edited: BusEvent.define("file.edited", z.object({ file: z.string() })),
  }
}
