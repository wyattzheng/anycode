import type { AgentContext } from "@/agent/context"
import { Slug } from "@/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { Config } from "../config/config"
import { Flag } from "../util/flag"
import { Installation } from "../util/installation"

import { NotFoundError } from "../storage"
import type { Filter } from "../storage"

import { Storage } from "@/storage"
import { Log } from "../util/log"
import { MessageV2 } from "./message-v2"

import { fn } from "@/util/fn"
import { Command } from "../agent/command"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { SessionID, MessageID, PartID } from "./schema"

import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { PermissionNext } from "@/permission/next"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"
import { iife } from "@/util/iife"

type WorkspaceID = string

// WorkspaceID stub (control-plane removed) — provides .zod for schema compatibility
const WorkspaceID = { zod: z.string() }

// WorkspaceContext stub (control-plane removed)
const WorkspaceContext = { workspaceID: undefined as string | undefined }

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "./prompt/qwen.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_CODEX from "./prompt/codex_header.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Agent } from "@/agent/agent"
import { Skill } from "@/skill"

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
    const share = row.share_url ? { url: row.share_url } : undefined
    const revert = row.revert ?? undefined
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
      share,
      revert,
      permission: row.permission ?? undefined,
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
      share_url: info.share?.url,
      summary_additions: info.summary?.additions,
      summary_deletions: info.summary?.deletions,
      summary_files: info.summary?.files,
      summary_diffs: info.summary?.diffs,
      revert: info.revert ?? null,
      permission: info.permission,
      time_created: info.time.created,
      time_updated: info.time.updated,
      time_compacting: info.time.compacting,
      time_archived: info.time.archived,
    }
  }

  function getForkedTitle(title: string): string {
    const match = title.match(/^(.+) \(fork #(\d+)\)$/)
    if (match) {
      const base = match[1]
      const num = parseInt(match[2], 10)
      return `${base} (fork #${num + 1})`
    }
    return `${title} (fork #1)`
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
          diffs: Snapshot.FileDiff.array().optional(),
        })
        .optional(),
      share: z
        .object({
          url: z.string(),
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
      permission: PermissionNext.Ruleset.optional(),
      revert: z
        .object({
          messageID: MessageID.zod,
          partID: PartID.zod.optional(),
          snapshot: z.string().optional(),
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
    Deleted: BusEvent.define(
      "session.deleted",
      z.object({
        info: Info,
      }),
    ),
    Diff: BusEvent.define(
      "session.diff",
      z.object({
        sessionID: SessionID.zod,
        diff: Snapshot.FileDiff.array(),
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
    permission?: PermissionNext.Ruleset
    workspaceID?: WorkspaceID
  }

  export const create = async (
    context: import("@any-code/opencode/agent/context").AgentContext,
    input?: CreateInput,
  ) => {
      return createNext(context, {
        parentID: input?.parentID,
        directory: context.directory,
        title: input?.title,
        permission: input?.permission,
        workspaceID: input?.workspaceID,
      })
    }

  export type ForkInput = {
    sessionID: SessionID
    messageID?: MessageID
  }

  export const fork = async (
    context: import("@any-code/opencode/agent/context").AgentContext,
    input: ForkInput,
  ) => {
      const original = await get(context, input.sessionID)
      if (!original) throw new Error("session not found")
      const title = getForkedTitle(original.title)
      const session = await createNext(context, {
        directory: context.directory,
        workspaceID: original.workspaceID,
        title,
      })
      const msgs = await messages(context, { sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = await updateMessage(context, {
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          await updatePart(context, {
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    }

  export async function touch(context: import("@any-code/opencode/agent/context").AgentContext, sessionID: any) {
    const now = Date.now()
    {
      const row = context.db.update("session",
        { op: "eq", field: "id", value: sessionID },
        { time_updated: now },
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
      const info = fromRow(row)
      Bus.publish(undefined, Event.Updated, { info })
    }
  }

  export async function createNext(
    context: import("@any-code/opencode/agent/context").AgentContext,
    input: {
      id?: SessionID
      title?: string
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
      permission?: PermissionNext.Ruleset
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
      permission: input.permission,
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
    const cfg = await context.config.get()
    if (!result.parentID && (Flag.OPENCODE_AUTO_SHARE || cfg.share === "auto"))
      share(result.id).catch(() => {
        // Silently ignore sharing errors during session creation
      })
    Bus.publish(context, Event.Updated, {
      info: result,
    })
    return result
  }

  export function plan(context: import("@any-code/opencode/agent/context").AgentContext, input: { slug: string; time: { created: number } }) {
    const base = context.project.vcs
      ? path.join(context.worktree, ".opencode", "plans")
      : path.join(context.paths.data, "plans")
    return path.join(base, [input.time.created, input.slug].join("-") + ".md")
  }

  export async function get(context: import("@any-code/opencode/agent/context").AgentContext, id: any) {
    const row = context.db.findOne("session", { op: "eq", field: "id", value: id })
    if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
    return fromRow(row)
  }

  export const share = fn(SessionID.zod, async (_id) => {
    throw new Error("Sharing is not available in agent mode")
  })

  export const unshare = fn(SessionID.zod, async (_id) => {
    throw new Error("Sharing is not available in agent mode")
  })

  export async function setTitle(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      { title: input.title },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function setArchived(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      { time_archived: input.time },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function setPermission(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      { permission: input.permission, time_updated: Date.now() },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function setRevert(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      {
        revert: input.revert ?? null,
        summary_additions: input.summary?.additions,
        summary_deletions: input.summary?.deletions,
        summary_files: input.summary?.files,
        time_updated: Date.now(),
      },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function clearRevert(context: import("@any-code/opencode/agent/context").AgentContext, sessionID: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: sessionID },
      {
        revert: null,
        time_updated: Date.now(),
      },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function setSummary(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    const row = context.db.update("session",
      { op: "eq", field: "id", value: input.sessionID },
      {
        summary_additions: input.summary?.additions,
        summary_deletions: input.summary?.deletions,
        summary_files: input.summary?.files,
        time_updated: Date.now(),
      },
    )
    if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
    const info = fromRow(row)
    Bus.publish(undefined, Event.Updated, { info })
    return info
  }

  export async function diff(context: AgentContext, sessionID: SessionID) {
    try {
      return await Storage.read<Snapshot.FileDiff[]>(context, ["session_diff", sessionID])
    } catch {
      return []
    }
  }

  export async function messages(context: import("@any-code/opencode/agent/context").AgentContext, input: { sessionID: any; limit?: number }) {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream(context, input.sessionID)) {
      if (input.limit && result.length >= input.limit) break
      result.push(msg)
    }
    result.reverse()
    return result
  }

  export function* list(
    context: import("@any-code/opencode/agent/context").AgentContext,
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
    context: import("@any-code/opencode/agent/context").AgentContext,
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

  export const children = async (
    context: import("@any-code/opencode/agent/context").AgentContext,
    parentID: SessionID,
  ) => {
    const project = context.project
    const rows = context.db.findMany("session", {
      filter: { op: "and", conditions: [
        { op: "eq", field: "project_id", value: project.id },
        { op: "eq", field: "parent_id", value: parentID },
      ]},
    })
    
    return rows.map(fromRow)
  }

  export const remove = async (
    context: import("@any-code/opencode/agent/context").AgentContext,
    sessionID: SessionID,
  ) => {
    const project = context.project
    try {
      const session = await get(context, sessionID)
      for (const child of await children(context, sessionID)) {
        await remove(context, child.id)
      }
      await unshare(sessionID).catch(() => {})
      // CASCADE delete handles messages and parts automatically
      {
        context.db.remove("session", { op: "eq", field: "id", value: sessionID })
        Bus.publish(context, Event.Deleted, {
            info: session,
          })
      }
    } catch (e) {
      log.error(e)
    }
  }

  export async function updateMessage(context: import("@any-code/opencode/agent/context").AgentContext, msg: any) {
    const time_created = msg.time.created
    const { id, sessionID, ...data } = msg
    {
      context.db.upsert("message",
        { id, session_id: sessionID, time_created, data },
        ["id"],
        { data },
      )
      Bus.publish(undefined, MessageV2.Event.Updated, {
          info: msg,
        })
    }
    return msg
  }

  export async function removeMessage(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    // CASCADE delete handles parts automatically
    context.db.remove("message",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.messageID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    Bus.publish(undefined, MessageV2.Event.Removed, {
      sessionID: input.sessionID,
      messageID: input.messageID,
    })
  }

  export async function removePart(context: import("@any-code/opencode/agent/context").AgentContext, input: any) {
    context.db.remove("part",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.partID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    Bus.publish(undefined, MessageV2.Event.PartRemoved, {
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
    })
  }

  const UpdatePartInput = MessageV2.Part

  export async function updatePart(context: import("@any-code/opencode/agent/context").AgentContext, part: any) {
    const { id, messageID, sessionID, ...data } = part
    const time = Date.now()
    context.db.upsert("part",
      { id, message_id: messageID, session_id: sessionID, time_created: time, data },
      ["id"],
      { data },
    )
    Bus.publish(undefined, MessageV2.Event.PartUpdated, {
      part: structuredClone(part),
    })
    return part
  }

  export const updatePartDelta = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
    async (input) => {
      Bus.publish(undefined, MessageV2.Event.PartDelta, input)
    },
  )

  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like OpenCode's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )

  export class BusyError extends Error {
    constructor(public readonly sessionID: string) {
      super(`Session ${sessionID} is busy`)
    }
  }

  export const initialize = fn(
    z.object({
      sessionID: SessionID.zod,
      modelID: ModelID.zod,
      providerID: ProviderID.zod,
      messageID: MessageID.zod,
    }).passthrough(),
    async (rawInput) => {
      const input = rawInput as typeof rawInput & { context: import("../agent/context").AgentContext }
      const { SessionPrompt } = await import("./session")
      await SessionPrompt.command({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: input.providerID + "/" + input.modelID,
        command: Command.Default.INIT,
        arguments: "",
        context: input.context,
      })
    },
  )
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

  /**
   * SessionStatusService — tracks per-session busy/idle/retry status.
   */
  export class SessionStatusService {
    private statuses: Record<string, Info> = {}

    constructor(private context?: AgentContext) {}

    get(sessionID: SessionID): Info {
      return this.statuses[sessionID] ?? { type: "idle" }
    }

    list(): Record<string, Info> {
      return this.statuses
    }

    set(sessionID: SessionID, status: Info): void {
      if (this.context) {
        Bus.publish(this.context, Event.Status, { sessionID, status })
      }
      if (status.type === "idle") {
        if (this.context) {
          Bus.publish(this.context, Event.Idle, { sessionID })
        }
        delete this.statuses[sessionID]
        return
      }
      this.statuses[sessionID] = status
    }
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

// Merged from session/system.ts
export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CODEX.trim()
  }

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
    if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    return [PROMPT_ANTHROPIC_WITHOUT_TODO]
  }

  export async function environment(model: Provider.Model, context: AgentContext) {
    const project = context.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${context.directory}`,
        `  Workspace root folder: ${context.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${
          project.vcs === "git" && false
            ? await context.search?.tree({ cwd: context.directory, limit: 50 })
            : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(context: AgentContext, agent: Agent.Info) {
    if (PermissionNext.disabled(["skill"], agent.permission).has("skill")) return

    const list = await context.skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      // the agents seem to ingest the information about skills a bit better if we present a more verbose
      // version of them here and a less verbose version in tool description, rather than vice versa.
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
