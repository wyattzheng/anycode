// ── NoSqlDb Interface (re-exported from @any-code/utils) ────────────────────

// ── NoSqlDb Interface (re-exported from @any-code/utils) ────────────────────

export type { Filter, FindManyOptions, NoSqlDb, RawSqliteDb } from "@any-code/utils"
export { SqliteNoSqlDb } from "@any-code/utils"

// ── Database ────────────────────────────────────────────────────────────────

import { NamedError } from "../util/error"
import * as path from "../util/path"

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

// ── SqliteNoSqlDb ───────────────────────────────────────────────────────────

/**
 * SqliteNoSqlDb — Translates NoSqlDb operations to raw SQL queries.
 *
 * Shared adapter for both sql.js and better-sqlite3 backends.
 * The backends only need to provide a minimal `RawSqliteDb` handle.
 */


// ── Storage ─────────────────────────────────────────────────────────────────

import type { AgentContext } from "../context"
import fs from "fs/promises"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"


export namespace Storage {
  function getLog(context: AgentContext) {
    return context.log.create({ service: "storage" })
  }

  type Migration = (context: AgentContext, dir: string) => Promise<void>

  export const NotFoundError = NamedError.create<"NotFoundError", {
    message: string
  }>("NotFoundError")

  const MIGRATIONS: Migration[] = [
    async (context, dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await context.fs.isDir(project))) return
      const projectDirs = await context.fs.glob("*", {
        cwd: project,
        nodir: false,
      })
      for (const projectDir of projectDirs) {
        const fullPath = path.join(project, projectDir)
        if (!(await context.fs.isDir(fullPath))) continue
        getLog(context).info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for (const msgFile of await context.fs.glob("storage/session/message/*/*.json", {
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await context.fs.readJson<any>(msgFile)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await context.fs.isDir(worktree))) continue
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

          await context.fs.writeJson(path.join(dir, "project", projectID + ".json"), {
            id,
            vcs: "git",
            worktree,
            time: {
              created: Date.now(),
              initialized: Date.now(),
            },
          })

          getLog(context).info(`migrating sessions for project ${projectID}`)
          for (const sessionFile of await context.fs.glob("storage/session/info/*.json", {
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            getLog(context).info("copying", {
              sessionFile,
              dest,
            })
            const session = await context.fs.readJson<any>(sessionFile)
            await context.fs.writeJson(dest, session)
            getLog(context).info(`migrating messages for session ${session.id}`)
            for (const msgFile of await context.fs.glob(`storage/session/message/${session.id}/*.json`, {
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              getLog(context).info("copying", {
                msgFile,
                dest,
              })
              const message = await context.fs.readJson<any>(msgFile)
              await context.fs.writeJson(dest, message)

              getLog(context).info(`migrating parts for message ${message.id}`)
              for (const partFile of await context.fs.glob(`storage/session/part/${session.id}/${message.id}/*.json`, {
                cwd: fullProjectDir,
                absolute: true,
              })) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await context.fs.readJson(partFile)
                getLog(context).info("copying", {
                  partFile,
                  dest,
                })
                await context.fs.writeJson(dest, part)
              }
            }
          }
        }
      }
    },
    async (context, dir) => {
      for (const item of await context.fs.glob("session/*/*.json", {
        cwd: dir,
        absolute: true,
      })) {
        const session = await context.fs.readJson<any>(item)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await context.fs.write(path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await context.fs.writeJson(path.join(dir, "session", session.projectID, session.id + ".json"), {
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
    const dir = path.join(context.dataPath, "storage")
    const migration = await context.fs.readJson<string>(path.join(dir, "migration"))
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      getLog(context).info("running migration", { index })
      const migrationFn = MIGRATIONS[index]
      await migrationFn(context, dir).catch(() => getLog(context).error("failed to run migration", { index }))
      await context.fs.write(path.join(dir, "migration"), (index + 1).toString())
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
      const result = await context.fs.readJson<T>(target)
      return result as T
    })
  }

  export async function update<T>(context: AgentContext, key: string[], fn: (draft: T) => void) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await context.fs.readJson<T>(target)
      fn(content as T)
      await context.fs.writeJson(target, content)
      return content
    })
  }

  export async function write<T>(context: AgentContext, key: string[], content: T) {
    const dir = await getDir(context)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await context.fs.writeJson(target, content)
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
      const result = await context.fs.glob("**/*", {
        cwd: path.join(dir, ...prefix),
        nodir: true,
      }).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
