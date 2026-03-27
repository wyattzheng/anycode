/**
 * SqlJsStorage — SQLite backend using sql.js (WASM).
 *
 * Supports optional file-backed persistence: pass a `dbPath` to the
 * constructor and the database will be loaded from / flushed to disk
 * automatically.  When no path is given it behaves as a pure in-memory
 * database (useful for tests).
 *
 * `connect()` is idempotent — multiple calls return the same NoSqlDb
 * instance and only initialise the database once.  This allows a single
 * SqlJsStorage to be shared across several CodeAgent instances.
 */
import fs from "fs"
import nodePath from "path"
import type { StorageProvider, Migration } from "./storage"
import { SqliteNoSqlDb, type NoSqlDb, type RawSqliteDb } from "./nosql"
import { getDefaultMigrations } from "./migrations"

export class SqlJsStorage implements StorageProvider {
    private db: any = null
    private noSqlDb: NoSqlDb | null = null
    private dbPath: string | null
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    private migrations: Migration[]

    constructor(dbPath?: string, migrations?: Migration[]) {
        this.dbPath = dbPath ?? null
        this.migrations = migrations ?? getDefaultMigrations()
    }

    async connect(): Promise<NoSqlDb> {
        // Idempotent: return cached client when already initialised
        if (this.noSqlDb) return this.noSqlDb

        const initSqlJs = (await import("sql.js")).default
        const SQL = await initSqlJs()

        // Load existing database file if available
        if (this.dbPath && fs.existsSync(this.dbPath)) {
            const buffer = fs.readFileSync(this.dbPath)
            this.db = new SQL.Database(new Uint8Array(buffer))
        } else {
            this.db = new SQL.Database()
        }

        // Enable foreign key support (required for CASCADE deletes)
        this.db.run("PRAGMA foreign_keys = ON")

        // Apply migrations
        this.applyMigrations(this.migrations)

        // Initial flush so the file exists even before the first write
        this.flushSync()

        // Wrap sql.js as RawSqliteDb
        const raw = this.createRawDb()
        this.noSqlDb = new SqliteNoSqlDb(raw)
        return this.noSqlDb
    }

    // ── Flush to disk ──────────────────────────────────────────────

    /** Schedule an async flush (debounced 100ms). */
    private scheduleFlush() {
        if (!this.dbPath) return
        if (this.flushTimer) return
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null
            this.flushSync()
        }, 100)
    }

    /** Synchronously write the entire database to disk. */
    private flushSync() {
        if (!this.dbPath || !this.db) return
        const dir = nodePath.dirname(this.dbPath)
        fs.mkdirSync(dir, { recursive: true })
        const data: Uint8Array = this.db.export()
        fs.writeFileSync(this.dbPath, Buffer.from(data))
    }

    // ── RawSqliteDb wrapper ────────────────────────────────────────

    private createRawDb(): RawSqliteDb {
        const db = this.db!
        const self = this
        return {
            run(sql: string, params?: any[]) {
                db.run(sql, params)
                self.scheduleFlush()
            },
            get(sql: string, params?: any[]): Record<string, any> | undefined {
                const stmt = db.prepare(sql)
                if (params) stmt.bind(params)
                if (!stmt.step()) {
                    stmt.free()
                    return undefined
                }
                const result = stmt.getAsObject()
                stmt.free()
                return result as Record<string, any>
            },
            all(sql: string, params?: any[]): Record<string, any>[] {
                const stmt = db.prepare(sql)
                if (params) stmt.bind(params)
                const results: Record<string, any>[] = []
                while (stmt.step()) {
                    results.push(stmt.getAsObject() as Record<string, any>)
                }
                stmt.free()
                return results
            },
            transaction(fn: () => void) {
                db.run("BEGIN TRANSACTION")
                try {
                    fn()
                    db.run("COMMIT")
                    self.scheduleFlush()
                } catch (e) {
                    db.run("ROLLBACK")
                    throw e
                }
            },
        }
    }

    // ── Migrations ─────────────────────────────────────────────────

    private applyMigrations(entries: Migration[]) {
        if (!this.db) throw new Error("SqlJsStorage: db not initialized")

        // Create migration tracking table
        this.db.run(`
            CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash TEXT NOT NULL,
                created_at INTEGER
            )
        `)

        // Get already applied migrations
        const applied = new Set<string>()
        const rows = this.db.exec(`SELECT hash FROM "__drizzle_migrations"`)
        if (rows.length > 0) {
            for (const row of rows[0].values) {
                applied.add(row[0] as string)
            }
        }

        // Apply pending migrations
        for (const entry of entries) {
            const hash = entry.name
            if (applied.has(hash)) continue
            this.db.run(entry.sql)
            this.db.run(
                `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`,
                [hash, entry.timestamp]
            )
        }
    }

    /** Run raw SQL (for server-specific DDL like extra tables). */
    exec(sql: string) {
        if (!this.db) throw new Error("SqlJsStorage: db not initialized")
        this.db.run(sql)
        this.scheduleFlush()
    }

    /** Run a SELECT query and return rows as objects. */
    query(sql: string, params?: any[]): Record<string, any>[] {
        if (!this.db) throw new Error("SqlJsStorage: db not initialized")
        const stmt = this.db.prepare(sql)
        if (params) stmt.bind(params)
        const results: Record<string, any>[] = []
        while (stmt.step()) {
            results.push(stmt.getAsObject() as Record<string, any>)
        }
        stmt.free()
        return results
    }

    close() {
        // Flush any pending writes before closing
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
            this.flushTimer = null
        }
        this.flushSync()

        if (this.db) {
            this.db.close()
            this.db = null
        }
        this.noSqlDb = null
    }
}
