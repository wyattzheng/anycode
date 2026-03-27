/**
 * StorageProvider — abstraction over the database backend.
 *
 * Provides a NoSqlDb interface for the application.
 * Implementations handle database creation, migration, and lifecycle.
 */
import type { NoSqlDb } from "./nosql"

export interface Migration {
    sql: string
    timestamp: number
    name: string
}

export interface StorageProvider {
    /**
     * Initialize the database, apply migrations, and return
     * a NoSqlDb client for queries.
     *
     * Migrations are baked into the implementation — callers
     * just call connect() and assume the schema is ready.
     */
    connect(): Promise<NoSqlDb>

    /**
     * Close the database connection and release resources.
     */
    close(): void
}
