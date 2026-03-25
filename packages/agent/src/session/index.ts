import type { AgentContext } from "../context"
import { EventEmitter } from "events"
import { Slug } from "../util/slug"
import * as path from "../util/path"

import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"

import { Flag } from "../util/flag"
import { Installation } from "../util/installation"
import { Memory } from "../memory"

import { NotFoundError } from "../storage"
import type { Filter } from "../storage"

import { Storage } from "../storage"
import { MessageV2 } from "../memory/message-v2"

import { fn } from "../util/fn"


import { ProjectID } from "../project"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"

import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "../util/fn"

type WorkspaceID = string

// WorkspaceID stub (control-plane removed) — provides .zod for schema compatibility
const WorkspaceID = { zod: z.string() }

// WorkspaceContext stub (control-plane removed)
const WorkspaceContext = { workspaceID: undefined as string | undefined }


const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

type SessionRow = Record<string, any>

function fromRow(row: SessionRow): Session.Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    parentID: row.parent_id ?? undefined,
    title: row.title,
    version: row.version,
    summary,
    revert: row.revert ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

function toRow(info: Session.Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    title: info.title,
    version: info.version,
    share_url: undefined as any,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    revert: info.revert ?? null,

    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}


// ── SessionService class ──────────────────────────────────────────────

export class SessionService extends EventEmitter {
  constructor(private ctx: AgentContext) {
    super()
  }

  static isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  static fromRow = fromRow
  static toRow = toRow
  static getUsage = Memory.getUsage

  async create(input?: Session.CreateInput) {
    return this.createNext({
      id: input?.id,
      parentID: input?.parentID,
      directory: this.ctx.directory,
      title: input?.title,
      workspaceID: input?.workspaceID,
    })
  }

  async touch(sessionID: any) {
    const now = Date.now()
    {
      const row = this.ctx.db.update("session",
        { op: "eq", field: "id", value: sessionID },
        { time_updated: now },
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      this.emit("session.updated", { info })
    }
  }

  async createNext(input: {
    id?: SessionID
    title?: string
    parentID?: SessionID
    workspaceID?: WorkspaceID
    directory: string
  }) {
    const result: Session.Info = {
      id: SessionID.descending(input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: this.ctx.project.id,
      directory: input.directory,
      workspaceID: input.workspaceID,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    this.ctx.log.create({ service: "session" }).info("created", result)
    {
      this.ctx.db.insert("session", toRow(result))
      this.emit("session.created", { info: result })
    }
    this.emit("session.updated", { info: result })
    return result
  }

  plan(input: { slug: string; time: { created: number } }) {
    const base = this.ctx.project.vcs
      ? path.join(this.ctx.worktree, ".opencode", "plans")
      : path.join(this.ctx.dataPath, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  async get(id: any) {
    const row = this.ctx.db.findOne("session", { op: "eq", field: "id", value: id })
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  }

  async getOrCreate(id?: string) {
    if (!id) return this.create()
    const row = this.ctx.db.findOne("session", { op: "eq", field: "id", value: id })
    if (row) return fromRow(row)
    return this.create({ id: id as any })
  }

  async setTitle(input: any) {
    const row = this.ctx.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      { title: input.title },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    this.emit("session.updated", { info })
    return info
  }

  async messages(input: { sessionID: any; limit?: number }) {
    return this.ctx.memory.messages(input)
  }

  *list(input?: {
    directory?: string
    workspaceID?: WorkspaceID
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }) {
    const project = this.ctx.project
    const conditions: Filter[] = [{ op: "eq", field: "project_id", value: project.id }]

    if (WorkspaceContext.workspaceID) {
      conditions.push({ op: "eq", field: "workspace_id", value: WorkspaceContext.workspaceID })
    }
    if (input?.directory) {
      conditions.push({ op: "eq", field: "directory", value: input.directory })
    }
    if (input?.roots) {
      conditions.push({ op: "isNull", field: "parent_id" })
    }
    if (input?.start) {
      conditions.push({ op: "gte", field: "time_updated", value: input.start })
    }
    if (input?.search) {
      conditions.push({ op: "like", field: "title", value: `%${input.search}%` })
    }

    const limit = input?.limit ?? 100

    const rows = this.ctx.db.findMany("session", {
      filter: { op: "and", conditions },
      orderBy: [{ field: "time_updated", direction: "desc" }],
      limit,
    })
    
    for (const row of rows) {
      yield fromRow(row)
    }
  }

  *listGlobal(input?: {
    directory?: string
    roots?: boolean
    start?: number
    cursor?: number
    search?: string
    limit?: number
    archived?: boolean
  }) {
    const conditions: Filter[] = []

    if (input?.directory) {
      conditions.push({ op: "eq", field: "directory", value: input.directory })
    }
    if (input?.roots) {
      conditions.push({ op: "isNull", field: "parent_id" })
    }
    if (input?.start) {
      conditions.push({ op: "gte", field: "time_updated", value: input.start })
    }
    if (input?.cursor) {
      conditions.push({ op: "lt", field: "time_updated", value: input.cursor })
    }
    if (input?.search) {
      conditions.push({ op: "like", field: "title", value: `%${input.search}%` })
    }
    if (!input?.archived) {
      conditions.push({ op: "isNull", field: "time_archived" })
    }

    const limit = input?.limit ?? 100

    const rows = this.ctx.db.findMany("session", {
      filter: conditions.length > 0 ? { op: "and", conditions } : undefined,
      orderBy: [{ field: "time_updated", direction: "desc" }, { field: "id", direction: "desc" }],
      limit,
    })

    const ids = [...new Set(rows.map((row: any) => row.project_id))]
    const projects = new Map<string, Session.ProjectInfo>()

    if (ids.length > 0) {
      const items = this.ctx.db.findMany("project", {
        filter: { op: "in", field: "id", values: ids },
        select: ["id", "name", "worktree"],
      })
      
      for (const item of items) {
        projects.set(item.id, {
          id: item.id,
          name: item.name ?? undefined,
          worktree: item.worktree,
        })
      }
    }

    for (const row of rows) {
      const project = projects.get(row.project_id) ?? null
      yield { ...fromRow(row), project }
    }
  }

  async updateMessage(msg: any) {
    return this.ctx.memory.updateMessage(msg)
  }

  async removeMessage(input: any) {
    return this.ctx.memory.removeMessage(input)
  }

  async removePart(input: any) {
    return this.ctx.memory.removePart(input)
  }

  async updatePart(part: any) {
    return this.ctx.memory.updatePart(part)
  }

  async updatePartDelta(input: any) {
    return this.ctx.memory.updatePartDelta(input)
  }

  updateTodo(input: { sessionID: SessionID; todos: Todo.Info[] }) {
    this.ctx.db.transaction((tx: any) => {
      tx.remove("todo", { op: "eq", field: "session_id", value: input.sessionID })
      if (input.todos.length === 0) return
      for (const [position, todo] of input.todos.entries()) {
        tx.insert("todo", {
          session_id: input.sessionID,
          content: todo.content,
          status: todo.status,
          priority: todo.priority,
          position,
        })
      }
    })
    this.emit("todo.updated", input)
  }

  getTodo(sessionID: SessionID) {
    const rows = this.ctx.db.findMany("todo", {
      filter: { op: "eq", field: "session_id", value: sessionID },
      orderBy: [{ field: "position", direction: "asc" }],
    })
    return rows.map((row: any) => ({
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }
}

// ── Session namespace (types/schemas only) ────────────────────────────

export namespace Session {
  export const Info = z
    .object({
      id: SessionID.zod,
      slug: z.string(),
      projectID: ProjectID.zod,
      workspaceID: WorkspaceID.zod.optional(),
      directory: z.string(),
      parentID: SessionID.zod.optional(),
      summary: z
        .object({
          additions: z.number(),
          deletions: z.number(),
          files: z.number(),
          diffs: MessageV2.FileDiff.array().optional(),
        })
        .optional(),
      title: z.string(),
      version: z.string(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        compacting: z.number().optional(),
        archived: z.number().optional(),
      }),
      revert: z
        .object({
          messageID: MessageID.zod,
          partID: PartID.zod.optional(),
          diff: z.string().optional(),
        })
        .optional(),
    })
    .meta({
      ref: "Session",
    })
  export type Info = z.output<typeof Info>

  export const ProjectInfo = z
    .object({
      id: ProjectID.zod,
      name: z.string().optional(),
      worktree: z.string(),
    })
    .meta({
      ref: "ProjectSummary",
    })
  export type ProjectInfo = z.output<typeof ProjectInfo>

  export const GlobalInfo = Info.extend({
    project: ProjectInfo.nullable(),
  }).meta({
    ref: "GlobalSession",
  })
  export type GlobalInfo = z.output<typeof GlobalInfo>

  export type CreateInput = {
    id?: SessionID
    parentID?: SessionID
    title?: string
    workspaceID?: WorkspaceID
  }

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }
}


// Merged from session/status.ts
export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>
}

// Merged from session/todo.ts
export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>
}
