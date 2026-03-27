
import { SessionID, MessageID, PartID } from "../session/schema"
import { NamedError } from "../util/error"
import { isAPICallError, isLoadAPIKeyError } from "@any-code/provider"
import { NotFoundError } from "../storage"
import type { Filter } from "../storage"
import { ProviderError, ModelID, ProviderID } from "@any-code/provider"

interface SystemError extends Error { code?: string; errno?: number; syscall?: string; path?: string }

export namespace MessageV2 {
  export function isMedia(mime: string) {
    return mime.startsWith("image/") || mime === "application/pdf"
  }

  // --- Error types (NamedError with plain generics) ---

  const OutputLengthError = NamedError.create<"MessageOutputLengthError", {}>("MessageOutputLengthError")
  const AbortedError = NamedError.create<"MessageAbortedError", { message: string }>("MessageAbortedError")
  export const StructuredOutputError = NamedError.create<"StructuredOutputError", {
    message: string
    retries: number
  }>("StructuredOutputError")
  const AuthError = NamedError.create<"ProviderAuthError", {
    providerID: string
    message: string
  }>("ProviderAuthError")

  interface APIErrorData {
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: Record<string, string>
    responseBody?: string
    metadata?: Record<string, string>
  }
  const APIError = NamedError.create<"APIError", APIErrorData>("APIError")

  export const ContextOverflowError = NamedError.create<"ContextOverflowError", {
    message: string
    responseBody?: string
  }>("ContextOverflowError")

  // --- Output format ---

  export type OutputFormat = { type: "text" } | { type: "json_schema"; schema: Record<string, any>; retryCount?: number }

  // --- File diffs ---

  export interface FileDiff {
    file: string
    before: string
    after: string
    additions: number
    deletions: number
    status?: "added" | "deleted" | "modified"
  }

  // --- Part base ---

  interface PartBase {
    id: PartID
    sessionID: SessionID
    messageID: MessageID
  }

  // --- Parts ---

  interface PatchPart extends PartBase {
    type: "patch"
    hash: string
    files: string[]
  }

  export interface TextPart extends PartBase {
    type: "text"
    text: string
    synthetic?: boolean
    ignored?: boolean
    time?: {
      start: number
      end?: number
    }
    metadata?: Record<string, any>
  }

  export interface ReasoningPart extends PartBase {
    type: "reasoning"
    text: string
    metadata?: Record<string, any>
    time: {
      start: number
      end?: number
    }
  }

  // --- File part sources ---

  interface FilePartSourceText {
    value: string
    start: number
    end: number
  }

  interface FileSource {
    type: "file"
    path: string
    text: FilePartSourceText
  }

  interface SymbolSource {
    type: "symbol"
    path: string
    range: {
      start: { line: number; character: number }
      end: { line: number; character: number }
    }
    name: string
    kind: number
    text: FilePartSourceText
  }

  interface ResourceSource {
    type: "resource"
    clientName: string
    uri: string
    text: FilePartSourceText
  }

  type FilePartSource = FileSource | SymbolSource | ResourceSource

  export interface FilePart extends PartBase {
    type: "file"
    mime: string
    filename?: string
    url: string
    source?: FilePartSource
  }

  export interface AgentPart extends PartBase {
    type: "agent"
    name: string
    source?: {
      value: string
      start: number
      end: number
    }
  }

  interface CompactionPart extends PartBase {
    type: "compaction"
    auto: boolean
    overflow?: boolean
  }

  export interface SubtaskPart extends PartBase {
    type: "subtask"
    prompt: string
    description: string
    agent: string
    model?: {
      providerID: ProviderID
      modelID: ModelID
    }
    command?: string
  }

  interface StepStartPart extends PartBase {
    type: "step-start"
  }

  export interface StepFinishPart extends PartBase {
    type: "step-finish"
    reason: string
    cost: number
    tokens: {
      total?: number
      input: number
      output: number
      reasoning: number
      cache: {
        read: number
        write: number
      }
    }
  }

  // --- Tool states ---

  interface ToolStatePending {
    status: "pending"
    input: Record<string, any>
    raw: string
  }

  interface ToolStateRunning {
    status: "running"
    input: Record<string, any>
    title?: string
    metadata?: Record<string, any>
    time: {
      start: number
    }
  }

  interface ToolStateCompleted {
    status: "completed"
    input: Record<string, any>
    output: string
    title: string
    metadata: Record<string, any>
    time: {
      start: number
      end: number
      compacted?: number
    }
    attachments?: FilePart[]
  }

  interface ToolStateError {
    status: "error"
    input: Record<string, any>
    error: string
    metadata?: Record<string, any>
    time: {
      start: number
      end: number
    }
  }

  type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

  export interface ToolPart extends PartBase {
    type: "tool"
    callID: string
    tool: string
    state: ToolState
    metadata?: Record<string, any>
  }

  // --- Part union ---

  export type Part =
    | TextPart
    | SubtaskPart
    | ReasoningPart
    | FilePart
    | ToolPart
    | StepStartPart
    | StepFinishPart
    | PatchPart
    | AgentPart
    | CompactionPart

  // --- Message types ---

  type ErrorObject =
    | ReturnType<InstanceType<typeof AuthError>["toObject"]>
    | ReturnType<InstanceType<typeof NamedError.Unknown>["toObject"]>
    | ReturnType<InstanceType<typeof OutputLengthError>["toObject"]>
    | ReturnType<InstanceType<typeof AbortedError>["toObject"]>
    | ReturnType<InstanceType<typeof StructuredOutputError>["toObject"]>
    | ReturnType<InstanceType<typeof ContextOverflowError>["toObject"]>
    | ReturnType<InstanceType<typeof APIError>["toObject"]>

  export interface User {
    id: MessageID
    sessionID: SessionID
    role: "user"
    time: {
      created: number
    }
    format?: OutputFormat
    summary?: {
      title?: string
      body?: string
      diffs: FileDiff[]
    }
    agent: string
    model: {
      providerID: ProviderID
      modelID: ModelID
    }
    system?: string
    tools?: Record<string, boolean>
    variant?: string
  }

  export interface Assistant {
    id: MessageID
    sessionID: SessionID
    role: "assistant"
    time: {
      created: number
      completed?: number
    }
    error?: ErrorObject
    parentID: MessageID
    modelID: ModelID
    providerID: ProviderID
    /** @deprecated */
    mode: string
    agent: string
    path: {
      cwd: string
      root: string
    }
    summary?: boolean
    cost?: number
    tokens?: {
      total?: number
      input: number
      output: number
      reasoning: number
      cache: {
        read: number
        write: number
      }
    }
    structured?: any
    variant?: string
    finish?: string
  }

  export type Info = User | Assistant

  export interface WithParts {
    info: Info
    parts: Part[]
  }

  // --- Cursor ---

  interface Cursor {
    id: MessageID
    time: number
  }

  const cursor = {
    encode(input: Cursor) {
      return Buffer.from(JSON.stringify(input)).toString("base64url")
    },
    decode(input: string): Cursor {
      return JSON.parse(Buffer.from(input, "base64url").toString("utf8")) as Cursor
    },
  }

  const info = (row: Record<string, any>) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
    }) as MessageV2.Info

  const part = (row: Record<string, any>) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    }) as MessageV2.Part

  const olderFilter = (cursor: Cursor): Filter => ({
    op: "or", conditions: [
      { op: "lt", field: "time_created", value: cursor.time },
      {
        op: "and", conditions: [
          { op: "eq", field: "time_created", value: cursor.time },
          { op: "lt", field: "id", value: cursor.id },
        ]
      },
    ],
  })

  async function hydrate(context: import("../context").AgentContext, rows: Record<string, any>[]) {
    const ids = rows.map((row) => row.id)
    const partByMessage = new Map<string, MessageV2.Part[]>()
    if (ids.length > 0) {
      const partRows = context.db.findMany("part", {
        filter: { op: "in", field: "message_id", values: ids },
        orderBy: [{ field: "message_id", direction: "asc" }, { field: "id", direction: "asc" }],
      })
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  }



  export async function page(context: import("../context").AgentContext, input: { sessionID: any; limit: number; before?: string }) {
    const before = input.before ? cursor.decode(input.before) : undefined
    const conditions: Filter[] = [{ op: "eq", field: "session_id", value: input.sessionID }]
    if (before) conditions.push(olderFilter(before))
    const rows = context.db.findMany("message", {
      filter: { op: "and", conditions },
      orderBy: [{ field: "time_created", direction: "desc" }, { field: "id", direction: "desc" }],
      limit: input.limit + 1,
    })
    if (rows.length === 0) {
      const row = context.db.findOne("session", { op: "eq", field: "id", value: input.sessionID })
      if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
      return {
        items: [] as MessageV2.WithParts[],
        more: false,
      }
    }

    const more = rows.length > input.limit
    const pg = more ? rows.slice(0, input.limit) : rows
    const items = await hydrate(context, pg)
    items.reverse()
    const tail = pg.at(-1)
    return {
      items,
      more,
      cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    }
  }

  export async function* stream(context: import("../context").AgentContext, sessionID: any) {
    const size = 50
    let before: string | undefined
    while (true) {
      const next = await page(context, { sessionID, limit: size, before })
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        yield next.items[i]
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
  }

  export async function parts(context: import("../context").AgentContext, message_id: any) {
    const rows = context.db.findMany("part", {
      filter: { op: "eq", field: "message_id", value: message_id },
      orderBy: [{ field: "id", direction: "asc" }],
    })
    return rows.map(
      (row: any) => ({ ...row.data, id: row.id, sessionID: row.session_id, messageID: row.message_id }) as MessageV2.Part,
    )
  }



  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    for await (const msg of stream) {
      result.push(msg)
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    result.reverse()
    return result
  }

  export function fromError(e: unknown, ctx: { providerID: ProviderID }): NonNullable<Assistant["error"]> {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case OutputLengthError.isInstance(e):
        return e
      case isLoadAPIKeyError(e):
        return new AuthError(
          {
            providerID: ctx.providerID,
            message: (e as Error).message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case isAPICallError(e):
        const parsed = ProviderError.parseAPICallError({
          providerID: ctx.providerID,
          error: e as any,
        })
        if (parsed.type === "context_overflow") {
          return new MessageV2.ContextOverflowError(
            {
              message: parsed.message,
              responseBody: parsed.responseBody,
            },
            { cause: e },
          ).toObject()
        }

        return new APIError(
          {
            message: parsed.message,
            statusCode: parsed.statusCode,
            isRetryable: parsed.isRetryable,
            responseHeaders: parsed.responseHeaders,
            responseBody: parsed.responseBody,
            metadata: parsed.metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        try {
          const parsed = ProviderError.parseStreamError(e)
          if (parsed) {
            if (parsed.type === "context_overflow") {
              return new MessageV2.ContextOverflowError(
                {
                  message: parsed.message,
                  responseBody: parsed.responseBody,
                },
                { cause: e },
              ).toObject()
            }
            return new APIError(
              {
                message: parsed.message,
                isRetryable: parsed.isRetryable,
                responseBody: parsed.responseBody,
              },
              {
                cause: e,
              },
            ).toObject()
          }
        } catch { }
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
    }
  }
}
