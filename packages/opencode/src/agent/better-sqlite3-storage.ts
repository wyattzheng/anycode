/**
 * BetterSqliteStorage — file-based SQLite backend using better-sqlite3.
 *
 * Used in production — wraps the native better-sqlite3 driver.
 * Returns a NoSqlDb interface backed by better-sqlite3.
 */
import type { StorageProvider, Migration } from "./code-agent"
import type { NoSqlDb } from "../storage/nosql"
import type { RawSqliteDb } from "../storage/sqlite-nosql"

export class BetterSqliteStorage implements StorageProvider {
    private sqlite: any = null
    private dataPath: string

    constructor(dataPath: string) {
        this.dataPath = dataPath
    }

    private async getDbPath(): Promise<string> {
        const path = await import("path")
        const { Installation } = await import("../util/installation")
        const { Flag } = await import("../util/flag")

        const channel = Installation.CHANNEL
        if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
            return path.join(this.dataPath, "opencode.db")
        const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
        return path.join(this.dataPath, `opencode-${safe}.db`)
    }

    async connect(migrations: Migration[]): Promise<NoSqlDb> {
        const BetterSqlite3 = (await import("better-sqlite3")).default

        const dbPath = await this.getDbPath()
        this.sqlite = new BetterSqlite3(dbPath)

        this.sqlite.pragma("journal_mode = WAL")
        this.sqlite.pragma("synchronous = NORMAL")
        this.sqlite.pragma("busy_timeout = 5000")
        this.sqlite.pragma("cache_size = -64000")
        this.sqlite.pragma("foreign_keys = ON")
        this.sqlite.pragma("wal_checkpoint(PASSIVE)")

        // Apply migrations
        this.applyMigrations(migrations)

        // Wrap better-sqlite3 as RawSqliteDb
        const raw = this.createRawDb()
        const { SqliteNoSqlDb } = await import("../storage/sqlite-nosql")
        return new SqliteNoSqlDb(raw)
    }

    private createRawDb(): RawSqliteDb {
        const db = this.sqlite!
        return {
            run(sql: string, params?: any[]) {
                db.prepare(sql).run(...(params ?? []))
            },
            get(sql: string, params?: any[]): Record<string, any> | undefined {
                return db.prepare(sql).get(...(params ?? [])) as Record<string, any> | undefined
            },
            all(sql: string, params?: any[]): Record<string, any>[] {
                return db.prepare(sql).all(...(params ?? [])) as Record<string, any>[]
            },
            transaction(fn: () => void) {
                db.transaction(fn)()
            },
        }
    }

    private applyMigrations(entries: Migration[]) {
        if (!this.sqlite) throw new Error("BetterSqliteStorage: db not initialized")

        this.sqlite.exec(`
            CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hash TEXT NOT NULL,
                created_at INTEGER
            )
        `)

        const applied = new Set(
            this.sqlite
                .prepare(`SELECT hash FROM "__drizzle_migrations"`)
                .all()
                .map((row: any) => row.hash as string),
        )

        for (const entry of entries) {
            const hash = entry.name
            if (applied.has(hash)) continue
            this.sqlite.exec(entry.sql)
            this.sqlite
                .prepare(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`)
                .run(hash, entry.timestamp)
        }
    }

    close() {
        if (this.sqlite) {
            this.sqlite.close()
            this.sqlite = null
        }
    }
}
