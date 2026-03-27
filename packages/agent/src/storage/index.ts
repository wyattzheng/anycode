// ── NoSqlDb Interface (re-exported from @any-code/utils) ────────────────────

// ── NoSqlDb Interface (re-exported from @any-code/utils) ────────────────────

export type { Filter, FindManyOptions, NoSqlDb, RawSqliteDb } from "@any-code/utils"
export { SqliteNoSqlDb } from "@any-code/utils"

// ── Database ────────────────────────────────────────────────────────────────

import { NamedError } from "../util/error"

import { Flag } from "../util/flag"

export const NotFoundError = NamedError.create<"NotFoundError", {
  message: string
}>("NotFoundError")

export namespace Database {
  /**
   * The db client type — NoSqlDb interface.
   */
  export type Client = any
  export type TxOrDb = any

  type Journal = { sql: string; timestamp: number; name: string }[]

  const INITIAL_MIGRATION = `-- project table
CREATE TABLE IF NOT EXISTS "project" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "worktree" TEXT NOT NULL,
  "vcs" TEXT,
  "name" TEXT,
  "icon_url" TEXT,
  "icon_color" TEXT,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_initialized" INTEGER,
  "sandboxes" TEXT NOT NULL DEFAULT '[]',
  "commands" TEXT
);

-- session table
CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "project_id" TEXT NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "workspace_id" TEXT,
  "parent_id" TEXT,
  "slug" TEXT NOT NULL,
  "directory" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "share_url" TEXT,
  "summary_additions" INTEGER,
  "summary_deletions" INTEGER,
  "summary_files" INTEGER,
  "summary_diffs" TEXT,
  "revert" TEXT,
  "permission" TEXT,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_compacting" INTEGER,
  "time_archived" INTEGER
);
CREATE INDEX IF NOT EXISTS "session_project_idx" ON "session"("project_id");
CREATE INDEX IF NOT EXISTS "session_workspace_idx" ON "session"("workspace_id");
CREATE INDEX IF NOT EXISTS "session_parent_idx" ON "session"("parent_id");

-- message table
CREATE TABLE IF NOT EXISTS "message" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "session_id" TEXT NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "data" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "message_session_time_created_id_idx" ON "message"("session_id", "time_created", "id");

-- part table
CREATE TABLE IF NOT EXISTS "part" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "message_id" TEXT NOT NULL REFERENCES "message"("id") ON DELETE CASCADE,
  "session_id" TEXT NOT NULL,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "data" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "part_message_id_id_idx" ON "part"("message_id", "id");
CREATE INDEX IF NOT EXISTS "part_session_idx" ON "part"("session_id");

-- todo table
CREATE TABLE IF NOT EXISTS "todo" (
  "session_id" TEXT NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "priority" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY ("session_id", "position")
);
CREATE INDEX IF NOT EXISTS "todo_session_idx" ON "todo"("session_id");

-- permission table
CREATE TABLE IF NOT EXISTS "permission" (
  "project_id" TEXT PRIMARY KEY NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "data" TEXT NOT NULL
);

-- session_share table
CREATE TABLE IF NOT EXISTS "session_share" (
  "session_id" TEXT PRIMARY KEY NOT NULL REFERENCES "session"("id") ON DELETE CASCADE,
  "id" TEXT NOT NULL,
  "secret" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- workspace table
CREATE TABLE IF NOT EXISTS "workspace" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "type" TEXT NOT NULL,
  "branch" TEXT,
  "name" TEXT,
  "directory" TEXT,
  "extra" TEXT,
  "project_id" TEXT NOT NULL REFERENCES "project"("id") ON DELETE CASCADE
);

-- account table
CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "email" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "refresh_token" TEXT NOT NULL,
  "token_expiry" INTEGER,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- account_state table
CREATE TABLE IF NOT EXISTS "account_state" (
  "id" INTEGER PRIMARY KEY,
  "active_account_id" TEXT REFERENCES "account"("id") ON DELETE SET NULL,
  "active_org_id" TEXT
);

-- control_account table (legacy)
CREATE TABLE IF NOT EXISTS "control_account" (
  "email" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "refresh_token" TEXT NOT NULL,
  "token_expiry" INTEGER,
  "active" INTEGER NOT NULL DEFAULT 0,
  "time_created" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  "time_updated" INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY ("email", "url")
);`

  /**
   * Returns the migration entries.
   */
  export function getMigrations(): Journal {
    const entries: Journal = [
      { sql: INITIAL_MIGRATION, timestamp: Date.UTC(2024, 0, 1), name: "20240101000000_initial" },
    ]
    if (Flag.OPENCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
    }
    return entries
  }
}




/**
 * SqliteNoSqlDb — Translates NoSqlDb operations to raw SQL queries.
 *
 * Shared adapter for both sql.js and better-sqlite3 backends.
 * The backends only need to provide a minimal `RawSqliteDb` handle.
 */
