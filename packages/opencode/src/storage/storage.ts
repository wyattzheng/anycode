import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { NamedError } from "@/util/error"
import z from "zod"
import { Glob } from "../util/glob"
import { git } from "@/util/git"

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
          const result = await git(["rev-list", "--max-parents=0", "--all"], {
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
