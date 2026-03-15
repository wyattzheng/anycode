import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import { Flag } from "../util/flag"
import { Filesystem } from "../util/filesystem"

/**
 * FileTimeService — tracks file read times and serializes concurrent writes.
 *
 * Provides per-session read timestamps and per-file write locks so
 * concurrent edits to the same file are serialized.
 */
export class FileTimeService {
  private log = Log.create({ service: "file.time" })
  private readTimes: {
    [sessionID: string]: {
      [path: string]: Date | undefined
    }
  } = {}
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
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const time = this.get(sessionID, filepath)
    if (!time) throw new Error(`You must read file ${filepath} before overwriting it. Use the Read tool first`)
    const s = await Filesystem.stat(context, filepath)
    const mtimeMs = s?.mtimeMs
    // Allow a 50ms tolerance for Windows NTFS timestamp fuzziness / async flushing
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
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    this.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(filepath) === chained) {
        this.locks.delete(filepath)
      }
    }
  }
}

// ── Backward-compatible namespace wrapper ──────────────────────────
// This ensures all code paths share the same FileTimeService instance.


export namespace FileTime {
  function svc(context: AgentContext) {
    if (context.fileTime) return context.fileTime
    return getState(context, STATE_KEY, () => new FileTimeService())
  }

  export function state(context: AgentContext) {
    // legacy API: returns the internal shape
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

