/**
 * SqlJsStorage — in-memory SQLite backend using sql.js (WASM).
 *
 * Used for tests — no filesystem needed.
 * Returns a NoSqlDb interface backed by sql.js.
 */
import type { StorageProvider, Migration } from "./storage"
import type { NoSqlDb, RawSqliteDb } from "@any-code/opencode/storage/index"

export class SqlJsStorage implements StorageProvider {
    private db: any = null

    async connect(migrations: Migration[]): Promise<NoSqlDb> {
        // Dynamic imports for sql.js (WASM) and our adapter
        const initSqlJs = (await import("sql.js")).default
        const SQL = await initSqlJs()
        this.db = new SQL.Database()

        // Enable foreign key support (required for CASCADE deletes)
        this.db.run("PRAGMA foreign_keys = ON")

        // Apply migrations
        this.applyMigrations(migrations)

        // Wrap sql.js as RawSqliteDb
        const raw = this.createRawDb()
        const { SqliteNoSqlDb } = await import("@any-code/opencode/storage/index")
        return new SqliteNoSqlDb(raw)
    }

    private createRawDb(): RawSqliteDb {
        const db = this.db!
        return {
            run(sql: string, params?: any[]) {
                db.run(sql, params)
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
                } catch (e) {
                    db.run("ROLLBACK")
                    throw e
                }
            },
        }
    }

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

    close() {
        if (this.db) {
            this.db.close()
            this.db = null
        }
    }
}
