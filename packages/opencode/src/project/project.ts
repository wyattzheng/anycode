import type { AgentContext } from "@/agent/context"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import path from "path"

import { Log } from "../util/log"
import { Flag } from "@/util/flag"
import { fn } from "@/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"


import { Glob } from "../util/glob"
import { which } from "../util/which"
import { ProjectID } from "./schema"

export namespace Project {
  const log = Log.create({ service: "project" })

  function gitpath(cwd: string, name: string) {
    if (!name) return cwd
    // git output includes trailing newlines; keep path whitespace intact.
    name = name.replace(/[\r\n]+$/, "")
    if (!name) return cwd

    name = Filesystem.windowsPath(name)

    if (path.isAbsolute(name)) return path.normalize(name)
    return path.resolve(cwd, name)
  }

  export const Info = z
    .object({
      id: ProjectID.zod,
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  type Row = Record<string, any>

  export function fromRow(row: Row): Info {
    const icon =
      row.icon_url || row.icon_color
        ? { url: row.icon_url ?? undefined, color: row.icon_color ?? undefined }
        : undefined
    return {
      id: ProjectID.make(row.id),
      worktree: row.worktree,
      vcs: row.vcs ? Info.shape.vcs.parse(row.vcs) : undefined,
      name: row.name ?? undefined,
      icon,
      time: {
        created: row.time_created,
        updated: row.time_updated,
        initialized: row.time_initialized ?? undefined,
      },
      sandboxes: row.sandboxes,
      commands: row.commands ?? undefined,
    }
  }

  function readCachedId(context: AgentContext, dir: string) {
    return Filesystem.readText(context, path.join(dir, "opencode"))
      .then((x) => x.trim())
      .then(ProjectID.make)
      .catch(() => undefined)
  }

  export async function fromDirectory(context: AgentContext, directory: string) {
    log.info("fromDirectory", { directory })

    const data = await iife(async () => {
      const matches = Filesystem.up(context, { targets: [".git"], start: directory })
      const dotgit = await matches.next().then((x) => x.value)
      await matches.return()
      if (dotgit) {
        let sandbox = path.dirname(dotgit)

        const gitBinary = which("git")

        // cached id calculation
        let id = await readCachedId(context, dotgit)

        if (!gitBinary) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        const worktree = await context.git.run(["rev-parse", "--git-common-dir"], {
          cwd: sandbox,
        })
          .then(async (result: any) => {
            const common = gitpath(sandbox, result.text())
            // Avoid going to parent of sandbox when git-common-dir is empty.
            return common === sandbox ? sandbox : path.dirname(common)
          })
          .catch(() => undefined)

        if (!worktree) {
          return {
            id: id ?? ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        // In the case of a git worktree, it can't cache the id
        // because `.git` is not a folder, but it always needs the
        // same project id as the common dir, so we resolve it now
        if (id == null) {
          id = await readCachedId(context, path.join(worktree, ".git"))
        }

        // generate id from root commit
        if (!id) {
          const roots = await context.git.run(["rev-list", "--max-parents=0", "HEAD"], {
            cwd: sandbox,
          })
            .then(async (result: any) =>
              result.text()
                .split("\n")
                .filter(Boolean)
                .map((x: string) => x.trim())
                .toSorted(),
            )
            .catch(() => undefined)

          if (!roots) {
            return {
              id: ProjectID.global,
              worktree: sandbox,
              sandbox,
              vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
            }
          }

          id = roots[0] ? ProjectID.make(roots[0]) : undefined
          if (id) {
            // Write to common dir so the cache is shared across worktrees.
            await Filesystem.write(context, path.join(worktree, ".git", "opencode"), id).catch(() => undefined)
          }
        }

        if (!id) {
          return {
            id: ProjectID.global,
            worktree: sandbox,
            sandbox,
            vcs: "git",
          }
        }

        const top = await context.git.run(["rev-parse", "--show-toplevel"], {
          cwd: sandbox,
        })
          .then(async (result: any) => gitpath(sandbox, result.text()))
          .catch(() => undefined)

        if (!top) {
          return {
            id,
            worktree: sandbox,
            sandbox,
            vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
          }
        }

        sandbox = top

        return {
          id,
          sandbox,
          worktree,
          vcs: "git",
        }
      }

      return {
        id: ProjectID.global,
        worktree: "/",
        sandbox: "/",
        vcs: Info.shape.vcs.parse(Flag.OPENCODE_FAKE_VCS),
      }
    })

    const row = context.db.findOne("project", { op: "eq", field: "id", value: data.id })
    const existing = row
      ? fromRow(row)
      : {
          id: data.id,
          worktree: data.worktree,
          vcs: data.vcs as Info["vcs"],
          sandboxes: [] as string[],
          time: {
            created: Date.now(),
            updated: Date.now(),
          },
        }

    if (Flag.OPENCODE_EXPERIMENTAL_ICON_DISCOVERY) discover(context, existing)

    const result: Info = {
      ...existing,
      worktree: data.worktree,
      vcs: data.vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (data.sandbox !== result.worktree && !result.sandboxes.includes(data.sandbox))
      result.sandboxes.push(data.sandbox)
    result.sandboxes = (await Promise.all(result.sandboxes.map(async (x) => ({ x, exists: await Filesystem.exists(context, x) })))).filter(r => r.exists).map(r => r.x)
    const insert = {
      id: result.id,
      worktree: result.worktree,
      vcs: result.vcs ?? null,
      name: result.name,
      icon_url: result.icon?.url,
      icon_color: result.icon?.color,
      time_created: result.time.created,
      time_updated: result.time.updated,
      time_initialized: result.time.initialized,
      sandboxes: result.sandboxes,
      commands: result.commands,
    }
    const updateSet = {
      worktree: result.worktree,
      vcs: result.vcs ?? null,
      name: result.name,
      icon_url: result.icon?.url,
      icon_color: result.icon?.color,
      time_updated: result.time.updated,
      time_initialized: result.time.initialized,
      sandboxes: result.sandboxes,
      commands: result.commands,
    }
    context.db.upsert("project", insert, ["id"], updateSet)
    
    // Runs after upsert so the target project row exists (FK constraint).
    // Runs on every startup because sessions created before git init
    // accumulate under "global" and need migrating whenever they appear.
    if (data.id !== ProjectID.global) {
      context.db.update("session",
        { op: "and", conditions: [{ op: "eq", field: "project_id", value: ProjectID.global }, { op: "eq", field: "directory", value: data.worktree }] },
        { project_id: data.id },
      )
    }
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox: data.sandbox }
  }

  export async function discover(context: AgentContext, input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const matches = await Glob.scan(context, "**/favicon.{ico,png,svg,jpg,jpeg,webp}", {
      cwd: input.worktree,
      absolute: true,
      include: "file",
    })
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const buffer = await Filesystem.readBytes(context, shortest)
    const base64 = Buffer.from(buffer).toString("base64")
    const mime = Filesystem.mimeType(shortest) || "image/png"
    const url = `data:${mime};base64,${base64}`
    await update(context, {
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  export function setInitialized(context: AgentContext, id: ProjectID) {
    context.db.update("project", { op: "eq", field: "id", value: id }, { time_initialized: Date.now() })
  }

  export function list(context: AgentContext) {
    return context.db.findMany("project").map((row: any) => fromRow(row))
  }

  export function get(context: AgentContext, id: ProjectID): Info | undefined {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) return undefined
    return fromRow(row)
  }

  export async function initGit(context: AgentContext, input: { directory: string; project: Info }) {
    if (input.project.vcs === "git") return input.project
    if (!which("git")) throw new Error("Git is not installed")

    const result = await context.git.run(["init", "--quiet"], {
      cwd: input.directory,
    })
    if (result.exitCode !== 0) {
      const text = result.stderr.toString().trim() || result.text().trim()
      throw new Error(text || "Failed to initialize git repository")
    }

    return (await fromDirectory(context, input.directory)).project
  }

  export async function update(context: AgentContext, input: { projectID: any; name?: string; icon?: any; commands?: any }) {
      const id = ProjectID.make(input.projectID)
      const result = context.db.update("project",
        { op: "eq", field: "id", value: id },
        {
          name: input.name,
          icon_url: input.icon?.url,
          icon_color: input.icon?.color,
          commands: input.commands,
          time_updated: Date.now(),
        },
      )
      
      if (!result) throw new Error(`Project not found: ${input.projectID}`)
      const data = fromRow(result)
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: data,
        },
      })
      return data
  }

  export async function sandboxes(context: AgentContext, id: ProjectID) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) return []
    const data = fromRow(row)
    const valid: string[] = []
    for (const dir of data.sandboxes) {
      const s = await Filesystem.stat(context, dir)
      if (s?.isDirectory) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(context: AgentContext, id: ProjectID, directory: string) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = [...row.sandboxes]
    if (!sandboxes.includes(directory)) sandboxes.push(directory)
    const result = context.db.update("project",
      { op: "eq", field: "id", value: id },
      { sandboxes, time_updated: Date.now() },
    )
    
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }

  export async function removeSandbox(context: AgentContext, id: ProjectID, directory: string) {
    const row = context.db.findOne("project", { op: "eq", field: "id", value: id })
    if (!row) throw new Error(`Project not found: ${id}`)
    const sandboxes = row.sandboxes.filter((s: any) => s !== directory)
    const result = context.db.update("project",
      { op: "eq", field: "id", value: id },
      { sandboxes, time_updated: Date.now() },
    )
    
    if (!result) throw new Error(`Project not found: ${id}`)
    const data = fromRow(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: data,
      },
    })
    return data
  }
}
