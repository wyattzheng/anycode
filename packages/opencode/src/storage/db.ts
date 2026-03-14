import BetterSqlite3 from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"

import { Log } from "../util/log"
import { NamedError } from "@/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"
import { Installation } from "../util/installation"
import { Flag } from "../util/flag"
import { iife } from "@/util/iife"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export namespace Database {
  let _dataPath: string | undefined

  export function init(dataPath: string) {
    _dataPath = dataPath
  }

  export const Path = lazy(() => {
    if (!_dataPath) throw new Error("Database dataPath not initialized")
    const channel = Installation.CHANNEL
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(_dataPath, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(_dataPath, `opencode-${safe}.db`)
  })

  type Schema = typeof schema
  export type Client = ReturnType<typeof drizzle<Schema>>
  export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as BetterSqlite3.Database | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Manual migration runner — replaces drizzle-orm's built-in migrate()
   * because better-sqlite3 migrator only accepts { migrationsFolder },
   * while we need to support the bundled array format (OPENCODE_MIGRATIONS).
   */
  function applyMigrations(sqlite: BetterSqlite3.Database, entries: Journal) {
    // Create migration tracking table if it doesn't exist
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER
      )
    `)

    const applied = new Set(
      sqlite
        .prepare(`SELECT hash FROM "__drizzle_migrations"`)
        .all()
        .map((row: any) => row.hash as string),
    )

    log.info("applyMigrations", { entryCount: entries.length, applied: [...applied] })

    for (const entry of entries) {
      const hash = entry.name
      if (applied.has(hash)) {
        log.info("skipping migration (already applied)", { hash })
        continue
      }

      log.info("executing migration", { hash, sqlLength: entry.sql.length })
      sqlite.exec(entry.sql)
      sqlite
        .prepare(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`)
        .run(hash, entry.timestamp)
      log.info("migration applied", { hash })
    }

    // Verify tables
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    log.info("tables after migration", { tables })
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: Path() })

    const sqlite = new BetterSqlite3(Path())
    state.sqlite = sqlite

    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("synchronous = NORMAL")
    sqlite.pragma("busy_timeout = 5000")
    sqlite.pragma("cache_size = -64000")
    sqlite.pragma("foreign_keys = ON")
    sqlite.pragma("wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite, schema })

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      applyMigrations(sqlite, entries)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
  }

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = (Client().transaction as any)((tx: TxOrDb) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }
}
