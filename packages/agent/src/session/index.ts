import type { AgentContext } from "../context"
import { Slug } from "../util/slug"
import * as path from "../util/path"
import { BusEvent } from "../bus"
import { Bus } from "../bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"

import { Flag } from "../util/flag"
import { Installation } from "../util/installation"
import { Memory } from "../memory"

import { NotFoundError } from "../storage"
import type { Filter } from "../storage"

import { Storage } from "../storage"
import { Log } from "../util/log"
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



export namespace Session {
  const log = Log.create({ service: "session" })

  const parentTitlePrefix = "New session - "
  const childTitlePrefix = "Child session - "

  function createDefaultTitle(isChild = false) {
    return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
  }

  export function isDefaultTitle(title: string) {
    return new RegExp(
      `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
    ).test(title)
  }

  type SessionRow = Record<string, any>

  export function fromRow(row: SessionRow): Info {
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

  export function toRow(info: Info) {
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

  export const Event = {
    Created: BusEvent.define(
      "session.created",
      z.object({
        info: Info,
      }),
    ),
    Updated: BusEvent.define(
      "session.updated",
      z.object({
        info: Info,
      }),
    ),
    Error: BusEvent.define(
      "session.error",
      z.object({
        sessionID: SessionID.zod.optional(),
        error: MessageV2.Assistant.shape.error,
      }),
    ),
  }

  export type CreateInput = {
    parentID?: SessionID
    title?: string
    workspaceID?: WorkspaceID
  }

  export const create = async (
    context: import("../context").AgentContext,
    input?: CreateInput,
  ) => {
      return createNext(context, {
        parentID: input?.parentID,
        directory: context.directory,
        title: input?.title,
        workspaceID: input?.workspaceID,
      })
    }


  export async function touch(context: import("../context").AgentContext, sessionID: any) {
    const now = Date.now()
    {
      const row = context.db.update("session",
        { op: "eq", field: "id", value: sessionID },
        { time_updated: now },
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Bus.publish(context, Event.Updated, { info })
    }
  }

  export async function createNext(
    context: import("../context").AgentContext,
    input: {
      id?: SessionID
      title?: string
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
    },
  ) {
    const result: Info = {
      id: SessionID.descending(input.id),
      slug: Slug.create(),
      version: Installation.VERSION,
      projectID: context.project.id,
      directory: input.directory,
      workspaceID: input.workspaceID,
      parentID: input.parentID,
      title: input.title ?? createDefaultTitle(!!input.parentID),
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    }
    log.info("created", result)
    {
      context.db.insert("session", toRow(result))
      Bus.publish(context, Event.Created, {
          info: result,
        })
    }
    Bus.publish(context, Event.Updated, {
      info: result,
    })
    return result
  }




  export function plan(context: import("../context").AgentContext, input: { slug: string; time: { created: number } }) {
    const base = context.project.vcs
      ? path.join(context.worktree, ".opencode", "plans")
      : path.join(context.dataPath, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export async function get(context: import("../context").AgentContext, id: any) {
    const row = context.db.findOne("session", { op: "eq", field: "id", value: id })
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  }



  export async function setTitle(context: import("../context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      { title: input.title },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(context, Event.Updated, { info })
    return info
  }



  export async function messages(context: import("../context").AgentContext, input: { sessionID: any; limit?: number }) {
    return context.memory.messages(input)
  }

  export function* list(
    context: import("../context").AgentContext,
    input?: {
      directory?: string
      workspaceID?: WorkspaceID
      roots?: boolean
      start?: number
      search?: string
      limit?: number
    },
  ) {
    const project = context.project
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

    const rows = context.db.findMany("session", {
      filter: { op: "and", conditions },
      orderBy: [{ field: "time_updated", direction: "desc" }],
      limit,
    })
    
    for (const row of rows) {
      yield fromRow(row)
    }
  }

  export function* listGlobal(
    context: import("../context").AgentContext,
    input?: {
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

    const rows = context.db.findMany("session", {
      filter: conditions.length > 0 ? { op: "and", conditions } : undefined,
      orderBy: [{ field: "time_updated", direction: "desc" }, { field: "id", direction: "desc" }],
      limit,
    })

    const ids = [...new Set(rows.map((row: any) => row.project_id))]
    const projects = new Map<string, ProjectInfo>()

    if (ids.length > 0) {
      const items = context.db.findMany("project", {
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



  export async function updateMessage(context: import("../context").AgentContext, msg: any) {
    return context.memory.updateMessage(msg)
  }

  export async function removeMessage(context: import("../context").AgentContext, input: any) {
    return context.memory.removeMessage(input)
  }

  export async function removePart(context: import("../context").AgentContext, input: any) {
    return context.memory.removePart(input)
  }

  export async function updatePart(context: import("../context").AgentContext, part: any) {
    return context.memory.updatePart(part)
  }

  export async function updatePartDelta(context: import("../context").AgentContext, input: any) {
    return context.memory.updatePartDelta(input)
  }

  export const getUsage = Memory.getUsage

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

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }


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

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export function update(context: AgentContext, input: { sessionID: SessionID; todos: Info[] }) {
    context.db.transaction((tx: any) => {
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
    Bus.publish(context, Event.Updated, input)
  }

  export function get(context: AgentContext, sessionID: SessionID) {
    const rows = context.db.findMany("todo", {
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
