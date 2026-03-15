// ── Schema SQL (Timestamps) ─────────────────────────────────────────────────

import { integer } from "drizzle-orm/sqlite-core"

export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
}

// ── Schema (table re-exports) ───────────────────────────────────────────────

// Account tables removed (account module deleted)
export { ProjectTable } from "../project"
export { SessionTable, MessageTable, PartTable, TodoTable, PermissionTable } from "../session/session.sql"

// ── NoSqlDb Interface ───────────────────────────────────────────────────────

/**
 * NoSqlDb — Simple NoSQL-style CRUD interface for storage.
 *
 * Business code uses this instead of drizzle-orm directly.
 * Implementations can be backed by SQLite, IndexedDB, in-memory Map, etc.
 */

/** Filter conditions for queries */
export type Filter =
  | { op: "eq"; field: string; value: any }
  | { op: "ne"; field: string; value: any }
  | { op: "gt"; field: string; value: any }
  | { op: "gte"; field: string; value: any }
  | { op: "lt"; field: string; value: any }
  | { op: "like"; field: string; value: string }
  | { op: "isNull"; field: string }
  | { op: "in"; field: string; values: any[] }
  | { op: "and"; conditions: Filter[] }
  | { op: "or"; conditions: Filter[] }

export interface FindManyOptions {
  filter?: Filter
  orderBy?: { field: string; direction: "asc" | "desc" }[]
  limit?: number
  /** Select specific fields only */
  select?: string[]
}

export interface NoSqlDb {
  /** Insert one row */
  insert(table: string, row: Record<string, any>): void

  /** Insert or update on primary-key conflict */
  upsert(
    table: string,
    row: Record<string, any>,
    conflictKeys: string[],
    updateFields: Record<string, any>,
  ): void

  /** Find one record matching filter */
  findOne(table: string, filter?: Filter, options?: { select?: string[] }): Record<string, any> | undefined

  /** Find multiple records */
  findMany(table: string, options?: FindManyOptions): Record<string, any>[]

  /** Update records matching filter, return first updated row (or undefined) */
  update(table: string, filter: Filter, set: Record<string, any>): Record<string, any> | undefined

  /** Delete records matching filter */
  remove(table: string, filter: Filter): void

  /** Run operations in a transaction */
  transaction(fn: (tx: NoSqlDb) => void): void
}

// ── Database ────────────────────────────────────────────────────────────────

import { NamedError } from "@/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "../util/flag"

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

export namespace Database {
  /**
   * The db client type — NoSqlDb interface.
   */
  export type Client = any
  export type TxOrDb = any

  type Journal = { sql: string; timestamp: number; name: string }[]

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
   * Returns the migration entries (bundled or from disk).
   */
  export function getMigrations(): Journal {
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? OPENCODE_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "../../migration"))
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    return entries
  }
}

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

// ── SqliteNoSqlDb ───────────────────────────────────────────────────────────

/**
 * SqliteNoSqlDb — Translates NoSqlDb operations to raw SQL queries.
 *
 * Shared adapter for both sql.js and better-sqlite3 backends.
 * The backends only need to provide a minimal `RawSqliteDb` handle.
 */

/**
 * Minimal raw SQLite handle — both sql.js and better-sqlite3
 * must implement this thin wrapper.
 */
export interface RawSqliteDb {
  /** Run a non-returning statement (INSERT, UPDATE, DELETE) */
  run(sql: string, params?: any[]): void
  /** Get one row */
  get(sql: string, params?: any[]): Record<string, any> | undefined
  /** Get all rows */
  all(sql: string, params?: any[]): Record<string, any>[]
  /** Run in transaction */
  transaction(fn: () => void): void
}

export class SqliteNoSqlDb implements NoSqlDb {
  constructor(private raw: RawSqliteDb) {}

  insert(table: string, row: Record<string, any>): void {
    const cols = Object.keys(row)
    const placeholders = cols.map(() => "?").join(", ")
    const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders})`
    this.raw.run(sql, cols.map(c => serialize(row[c])))
  }

  upsert(
    table: string,
    row: Record<string, any>,
    conflictKeys: string[],
    updateFields: Record<string, any>,
  ): void {
    const cols = Object.keys(row)
    const placeholders = cols.map(() => "?").join(", ")
    const conflict = conflictKeys.map(k => `"${k}"`).join(", ")
    const updates = Object.keys(updateFields)
      .map(k => `"${k}" = ?`)
      .join(", ")
    const sql = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(", ")}) VALUES (${placeholders}) ON CONFLICT (${conflict}) DO UPDATE SET ${updates}`
    const params = [
      ...cols.map(c => serialize(row[c])),
      ...Object.keys(updateFields).map(k => serialize(updateFields[k])),
    ]
    this.raw.run(sql, params)
  }

  findOne(
    table: string,
    filter?: Filter,
    options?: { select?: string[] },
  ): Record<string, any> | undefined {
    const fields = options?.select?.map(f => `"${f}"`).join(", ") ?? "*"
    const { clause, params } = filter ? buildWhere(filter) : { clause: "", params: [] }
    const where = clause ? ` WHERE ${clause}` : ""
    const sql = `SELECT ${fields} FROM "${table}"${where} LIMIT 1`
    const row = this.raw.get(sql, params)
    return row ? deserializeRow(row) : undefined
  }

  findMany(table: string, options?: FindManyOptions): Record<string, any>[] {
    const fields = options?.select?.map(f => `"${f}"`).join(", ") ?? "*"
    const { clause, params } = options?.filter ? buildWhere(options.filter) : { clause: "", params: [] }
    const where = clause ? ` WHERE ${clause}` : ""

    let orderClause = ""
    if (options?.orderBy?.length) {
      const parts = options.orderBy.map(
        o => `"${o.field}" ${o.direction === "desc" ? "DESC" : "ASC"}`,
      )
      orderClause = ` ORDER BY ${parts.join(", ")}`
    }

    const limitClause = options?.limit != null ? ` LIMIT ${options.limit}` : ""
    const sql = `SELECT ${fields} FROM "${table}"${where}${orderClause}${limitClause}`
    return this.raw.all(sql, params).map(deserializeRow)
  }

  update(
    table: string,
    filter: Filter,
    set: Record<string, any>,
  ): Record<string, any> | undefined {
    const setCols = Object.keys(set)
    const setClause = setCols.map(k => `"${k}" = ?`).join(", ")
    const { clause, params } = buildWhere(filter)
    const sql = `UPDATE "${table}" SET ${setClause} WHERE ${clause} RETURNING *`
    const setParams = setCols.map(k => serialize(set[k]))
    const row = this.raw.get(sql, [...setParams, ...params])
    return row ? deserializeRow(row) : undefined
  }

  remove(table: string, filter: Filter): void {
    const { clause, params } = buildWhere(filter)
    this.raw.run(`DELETE FROM "${table}" WHERE ${clause}`, params)
  }

  transaction(fn: (tx: NoSqlDb) => void): void {
    this.raw.transaction(() => {
      fn(this)
    })
  }
}

// ── SQLite Helpers ──────────────────────────────────────────────────────────

function buildWhere(filter: Filter): { clause: string; params: any[] } {
  switch (filter.op) {
    case "eq":
      return { clause: `"${filter.field}" = ?`, params: [serialize(filter.value)] }
    case "ne":
      return { clause: `"${filter.field}" != ?`, params: [serialize(filter.value)] }
    case "gt":
      return { clause: `"${filter.field}" > ?`, params: [serialize(filter.value)] }
    case "gte":
      return { clause: `"${filter.field}" >= ?`, params: [serialize(filter.value)] }
    case "lt":
      return { clause: `"${filter.field}" < ?`, params: [serialize(filter.value)] }
    case "like":
      return { clause: `"${filter.field}" LIKE ?`, params: [filter.value] }
    case "isNull":
      return { clause: `"${filter.field}" IS NULL`, params: [] }
    case "in": {
      const placeholders = filter.values.map(() => "?").join(", ")
      return { clause: `"${filter.field}" IN (${placeholders})`, params: filter.values.map(serialize) }
    }
    case "and": {
      const parts = filter.conditions.map(buildWhere)
      return {
        clause: parts.map(p => `(${p.clause})`).join(" AND "),
        params: parts.flatMap(p => p.params),
      }
    }
    case "or": {
      const parts = filter.conditions.map(buildWhere)
      return {
        clause: parts.map(p => `(${p.clause})`).join(" OR "),
        params: parts.flatMap(p => p.params),
      }
    }
  }
}

/** Serialize JS values for SQLite storage (objects → JSON strings) */
function serialize(value: any): any {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === "object" && !(value instanceof Buffer) && !(value instanceof Uint8Array)) {
    return JSON.stringify(value)
  }
  return value
}

/** Deserialize a row — parse JSON columns back to objects */
function deserializeRow(row: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        result[key] = JSON.parse(value)
      } catch {
        result[key] = value
      }
    } else {
      result[key] = value
    }
  }
  return result
}

// ── Storage ─────────────────────────────────────────────────────────────────

import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { Glob } from "../util/glob"


export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (context: AgentContext, dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (context, dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(context, project))) return
      const projectDirs = await Glob.scan(context, "*", {
        cwd: project,
        include: "all",
      })
      for (const projectDir of projectDirs) {
        const fullPath = path.join(project, projectDir)
        if (!(await Filesystem.isDir(context, fullPath))) continue
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for (const msgFile of await Glob.scan(context, "storage/session/message/*/*.json", {
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Filesystem.readJson<any>(context, msgFile)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(context, worktree))) continue
          const result = await context.git.run(["rev-list", "--max-parents=0", "--all"], {
            cwd: worktree,
          })
          const [id] = result
            .text()
            .split("\n")
            .filter(Boolean)
            .map((x) => x.trim())
            .toSorted()
          if (!id) continue
          projectID = id

          await Filesystem.writeJson(context, path.join(dir, "project", projectID + ".json"), {
            id,
            vcs: "git",
            worktree,
            time: {
              created: Date.now(),
              initialized: Date.now(),
            },
          })

          log.info(`migrating sessions for project ${projectID}`)
          for (const sessionFile of await Glob.scan(context, "storage/session/info/*.json", {
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Filesystem.readJson<any>(context, sessionFile)
            await Filesystem.writeJson(context, dest, session)
            log.info(`migrating messages for session ${session.id}`)
            for (const msgFile of await Glob.scan(context, `storage/session/message/${session.id}/*.json`, {
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Filesystem.readJson<any>(context, msgFile)
              await Filesystem.writeJson(context, dest, message)

              log.info(`migrating parts for message ${message.id}`)
              for (const partFile of await Glob.scan(context, `storage/session/part/${session.id}/${message.id}/*.json`, {
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Filesystem.readJson(context, partFile)
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Filesystem.writeJson(context, dest, part)
              }
            }
          }
        }
      }
    },
    async (context, dir) => {
      for (const item of await Glob.scan(context, "session/*/*.json", {
        cwd: dir,
        absolute: true,
      })) {
        const session = await Filesystem.readJson<any>(context, item)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Filesystem.write(context, path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await Filesystem.writeJson(context, path.join(dir, "session", session.projectID, session.id + ".json"), {
          ...session,
          summary: {
            additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
            deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
          },
        })
      }
    },
  ]

  async function getDir(context: AgentContext) {
    const dir = path.join(context.paths.data, "storage")
    const migration = await Filesystem.readJson<string>(context, path.join(dir, "migration"))
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migrationFn = MIGRATIONS[index]
      await migrationFn(context, dir).catch(() => log.error("failed to run migration", { index }))
      await Filesystem.write(context, path.join(dir, "migration"), (index + 1).toString())
    }
    return dir
  }

  export async function remove(context: AgentContext, key: string[]) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(context: AgentContext, key: string[]) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Filesystem.readJson<T>(context, target)
      return result as T
    })
  }

  export async function update<T>(context: AgentContext, key: string[], fn: (draft: T) => void) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Filesystem.readJson<T>(context, target)
      fn(content as T)
      await Filesystem.writeJson(context, target, content)
      return content
    })
  }

  export async function write<T>(context: AgentContext, key: string[], content: T) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await Filesystem.writeJson(context, target, content)
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  export async function list(context: AgentContext, prefix: string[]) {
    const dir = await getDir(context)
    try {
      const result = await Glob.scan(context, "**/*", {
        cwd: path.join(dir, ...prefix),
        include: "file",
      }).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
