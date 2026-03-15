import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import { Flag } from "../util/flag"
import { Filesystem } from "../util/filesystem"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  const STATE_KEY = Symbol("file.time")
  export function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => {
      const read: {
        [sessionID: string]: {
          [path: string]: Date | undefined
        }
      } = {}
      const locks = new Map<string, Promise<void>>()
      return { read, locks }
    })
  }

  export function read(context: AgentContext, sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state(context)
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = new Date()
  }

  export function get(context: AgentContext, sessionID: string, file: string) {
    return state(context).read[sessionID]?.[file]
  }

  export async function withLock<T>(context: AgentContext, filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state(context)
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(context: AgentContext, sessionID: string, filepath: string) {
    if (Flag.OPENCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const time = get(context, sessionID, filepath)
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
}
