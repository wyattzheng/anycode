/**
 * StorageProvider — abstraction over the database backend.
 *
 * Provides a NoSqlDb interface for the application.
 * Implementations handle database creation, migration, and lifecycle.
 */
import type { NoSqlDb } from "@any-code/opencode/storage/index"

export interface Migration {
    sql: string
    timestamp: number
    name: string
}

export interface StorageProvider {
    /**
     * Initialize the database, apply migrations, and return
     * a NoSqlDb client for queries.
     */
    connect(migrations: Migration[]): Promise<NoSqlDb>

    /**
     * Close the database connection and release resources.
     */
    close(): void
}
