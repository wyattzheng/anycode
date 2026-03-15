// ── Protected ───────────────────────────────────────────────────────────────

import path from "path"
import os from "os"

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

import { Glob } from "../util/glob"

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

import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import { Flag } from "../util/flag"
import { Filesystem } from "../util/filesystem"

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

// ── FileWatcher ─────────────────────────────────────────────────────────────

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import { lazy } from "@/util/lazy"
import { withTimeout } from "@/util/timeout"
import type ParcelWatcher from "@parcel/watcher"
import { readdir } from "fs/promises"

const SUBSCRIBE_TIMEOUT_MS = 10_000

declare const OPENCODE_LIBC: string | undefined

export namespace FileWatcher {
  const log = Log.create({ service: "file.watcher" })

  export const Event = {
    Updated: BusEvent.define(
      "file.watcher.updated",
      z.object({
        file: z.string(),
        event: z.union([z.literal("add"), z.literal("change"), z.literal("unlink")]),
      }),
    ),
  }

  const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
    try {
      const binding = require(
        `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
      )
      return createWrapper(binding) as typeof import("@parcel/watcher")
    } catch (error) {
      log.error("failed to load watcher binding", { error })
      return
    }
  })

  export class FileWatcherService {
    readonly _promise: Promise<{ subs?: ParcelWatcher.AsyncSubscription[] }>

    constructor(context: AgentContext) {
      this._promise = this.init(context)
    }

    private async init(context: AgentContext) {
      log.info("init")
      const cfg = context.config
      const backend = (() => {
        if (process.platform === "win32") return "windows"
        if (process.platform === "darwin") return "fs-events"
        if (process.platform === "linux") return "inotify"
      })()
      if (!backend) {
        log.error("watcher backend not supported", { platform: process.platform })
        return {}
      }
      log.info("watcher backend", { platform: process.platform, backend })

      const w = watcher()
      if (!w) return {}

      const subscribe: ParcelWatcher.SubscribeCallback = (err, evts) => {
        if (err) return
        for (const evt of evts) {
          if (evt.type === "create") Bus.publish(context, Event.Updated, { file: evt.path, event: "add" })
          if (evt.type === "update") Bus.publish(context, Event.Updated, { file: evt.path, event: "change" })
          if (evt.type === "delete") Bus.publish(context, Event.Updated, { file: evt.path, event: "unlink" })
        }
      }

      const subs: ParcelWatcher.AsyncSubscription[] = []
      const cfgIgnores = cfg.watcher?.ignore ?? []

      if (Flag.OPENCODE_EXPERIMENTAL_FILEWATCHER) {
        const pending = w.subscribe(context.directory, subscribe, {
          ignore: [...FileIgnore.PATTERNS, ...cfgIgnores, ...Protected.paths()],
          backend,
        })
        const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
          log.error("failed to subscribe to context.directory", { error: err })
          pending.then((s) => s.unsubscribe()).catch(() => {})
          return undefined
        })
        if (sub) subs.push(sub)
      }

      if (context.project.vcs === "git") {
        const result = await context.git.run(["rev-parse", "--git-dir"], { cwd: context.worktree })
        const vcsDir = result.exitCode === 0 ? path.resolve(context.worktree, result.text().trim()) : undefined
        if (vcsDir && !cfgIgnores.includes(".git") && !cfgIgnores.includes(vcsDir)) {
          const gitDirContents = await readdir(vcsDir).catch(() => [])
          const ignoreList = gitDirContents.filter((entry) => entry !== "HEAD")
          const pending = w.subscribe(vcsDir, subscribe, { ignore: ignoreList, backend })
          const sub = await withTimeout(pending, SUBSCRIBE_TIMEOUT_MS).catch((err) => {
            log.error("failed to subscribe to vcsDir", { error: err })
            pending.then((s) => s.unsubscribe()).catch(() => {})
            return undefined
          })
          if (sub) subs.push(sub)
        }
      }

      return { subs }
    }
  }
}

// ── File ────────────────────────────────────────────────────────────────────

import { formatPatch, structuredPatch } from "diff"
import ignore from "ignore"
import fuzzysort from "fuzzysort"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({ ref: "File" })
  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({ ref: "FileNode" })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.enum(["text", "binary"]),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(z.object({
            oldStart: z.number(), oldLines: z.number(),
            newStart: z.number(), newLines: z.number(),
            lines: z.array(z.string()),
          })),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({ ref: "FileContent" })
  export type Content = z.infer<typeof Content>

  const binaryExtensions = new Set([
    "exe","dll","pdb","bin","so","dylib","o","a","lib",
    "wav","mp3","ogg","oga","ogv","ogx","flac","aac","wma","m4a","weba",
    "mp4","avi","mov","wmv","flv","webm","mkv",
    "zip","tar","gz","gzip","bz","bz2","bzip","bzip2","7z","rar","xz","lz","z",
    "pdf","doc","docx","ppt","pptx","xls","xlsx",
    "dmg","iso","img","vmdk",
    "ttf","otf","woff","woff2","eot",
    "sqlite","db","mdb",
    "apk","ipa","aab","xapk","app","pkg","deb","rpm","snap","flatpak","appimage","msi","msp",
    "jar","war","ear","class","kotlin_module","dex","vdex","odex","oat","art",
    "wasm","wat","bc","ll","s","ko","sys","drv","efi","rom","com",
    "cmd","ps1","sh","bash","zsh","fish",
  ])

  const imageExtensions = new Set([
    "png","jpg","jpeg","gif","bmp","webp","ico","tif","tiff","svg","svgz",
    "avif","apng","jxl","heic","heif","raw","cr2","nef","arw","dng","orf","raf","pef","x3f",
  ])

  const textExtensions = new Set([
    "ts","tsx","mts","cts","mtsx","ctsx","js","jsx","mjs","cjs",
    "sh","bash","zsh","fish","ps1","psm1","cmd","bat",
    "json","jsonc","json5","yaml","yml","toml",
    "md","mdx","txt","xml","html","htm",
    "css","scss","sass","less","graphql","gql","sql",
    "ini","cfg","conf","env",
  ])

  const textNames = new Set([
    "dockerfile","makefile",".gitignore",".gitattributes",".editorconfig",
    ".npmrc",".nvmrc",".prettierrc",".eslintrc",
  ])

  function isImageByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return imageExtensions.has(ext)
  }

  function isTextByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return textExtensions.has(ext)
  }

  function isTextByName(filepath: string): boolean {
    const name = path.basename(filepath).toLowerCase()
    return textNames.has(name)
  }

  function getImageMimeType(filepath: string): string {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    const mimeTypes: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
      ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
      svg: "image/svg+xml", svgz: "image/svg+xml",
      avif: "image/avif", apng: "image/apng", jxl: "image/jxl",
      heic: "image/heic", heif: "image/heif",
    }
    return mimeTypes[ext] || "image/" + ext
  }

  function isBinaryByExtension(filepath: string): boolean {
    const ext = path.extname(filepath).toLowerCase().slice(1)
    return binaryExtensions.has(ext)
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith("image/")
  }

  async function shouldEncode(mimeType: string): Promise<boolean> {
    const type = mimeType.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false
    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false
    const parts = type.split("/", 2)
    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(parts[0])) return true
    return false
  }

  export const Event = {
    Edited: BusEvent.define("file.edited", z.object({ file: z.string() })),
  }

  export class FileService {
    readonly _promise: ReturnType<typeof initFile>
    constructor(context: AgentContext) {
      this._promise = initFile(context)
    }
  }

  async function initFile(context: AgentContext) {
    type Entry = { files: string[]; dirs: string[] }
    let cache: Entry = { files: [], dirs: [] }
    let fetching = false
    const isGlobalHome = context.directory === context.paths.home && context.project.id === "global"

    const fn = async (context: AgentContext, result: Entry) => {
      if (context.directory === path.parse(context.directory).root) return
      fetching = true

      if (isGlobalHome) {
        const dirs = new Set<string>()
        const ignore = Protected.names()
        const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        const shouldIgnore = (name: string) => name.startsWith(".") || ignore.has(name)
        const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)

        const top = await context.fs.readDir(context.directory).catch(() => [] as { name: string; isDirectory: boolean }[])
        for (const entry of top) {
          if (!entry.isDirectory) continue
          if (shouldIgnore(entry.name)) continue
          dirs.add(entry.name + "/")
          const base = path.join(context.directory, entry.name)
          const children = await context.fs.readDir(base).catch(() => [] as { name: string; isDirectory: boolean }[])
          for (const child of children) {
            if (!child.isDirectory) continue
            if (shouldIgnoreNested(child.name)) continue
            dirs.add(entry.name + "/" + child.name + "/")
          }
        }
        result.dirs = Array.from(dirs).toSorted()
        cache = result
        fetching = false
        return
      }

      const set = new Set<string>()
      const filePaths = await context.search.listFiles({ cwd: context.directory })
      for (const file of filePaths) {
        result.files.push(file)
        let current = file
        while (true) {
          const dir = path.dirname(current)
          if (dir === "." || dir === current) break
          current = dir
          if (set.has(dir)) continue
          set.add(dir)
          result.dirs.push(dir + "/")
        }
      }
      cache = result
      fetching = false
    }
    fn(context, cache)

    return {
      async files() {
        if (!fetching) fn(context, { files: [], dirs: [] })
        return cache
      },
    }
  }
}
