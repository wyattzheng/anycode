import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "child_process"
import { randomUUID } from "crypto"
import { promises as fsPromises } from "fs"
import { createRequire } from "module"
import { dirname as dirnamePath, resolve as resolvePath } from "path"
import { createInterface } from "readline"
import z from "zod"
import { consoleLogger, type ChatAgentConfig, type ChatAgentEvent, type IChatAgent, type Logger } from "@any-code/utils"

export type { IChatAgent, ChatAgentEvent, ChatAgentConfig }

const require = createRequire(import.meta.url)

const OFFICIAL_CLIENT_INFO = {
  name: "codex_vscode",
  title: "Codex VS Code Extension",
  version: "0.1.0",
}

const CUSTOM_TOOL_IDS = new Set(["set_user_watch_project", "user_watch_terminal", "set_preview_url"])
const RESUME_TOKEN_PREFIX = "codexapp:"
const OPENAI_OAUTH_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const OPENAI_OAUTH_REFRESH_SCOPES = "openid profile email"
const OPENAI_OAUTH_USER_AGENT = "codex-cli/0.116.0"
const OPENAI_ACCESS_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const RESPONSES_PATH_SUFFIX = "/responses"
const OPENAI_V1_SUFFIX = "/v1"
const CHATGPT_BACKEND_API_SUFFIX = "/backend-api"

type ResumeState = {
  version: 1
  threadId: string
}

type ToolExecutionResult = {
  title: string
  metadata: Record<string, unknown>
  output: string
  attachments?: Array<Record<string, unknown>>
  success?: boolean
}

type RuntimeTool = {
  id: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: any, ctx: any) => Promise<ToolExecutionResult>
}

type ExternalToolInitResult = {
  description: string
  parameters: any
  execute: (args: any, ctx: any) => Promise<any>
}

type ExternalToolDefinition = {
  id: string
  init: () => Promise<ExternalToolInitResult> | ExternalToolInitResult
}

type DynamicToolContentItem =
  | { type: "inputText", text: string }
  | { type: "inputImage", imageUrl: string }

type JsonRpcResponseMessage = {
  jsonrpc?: string
  id: number | string
  result?: any
  error?: {
    code?: number
    message?: string
    data?: unknown
  }
}

type JsonRpcNotificationMessage = {
  jsonrpc?: string
  method: string
  params?: any
}

type JsonRpcRequestMessage = {
  jsonrpc?: string
  id: number | string
  method: string
  params?: any
}

type UsageBreakdown = {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cost: number
}

type HistoryMessage =
  | { id: string, role: "user", text: string, createdAt: number }
  | { id: string, role: "assistant", parts: Array<{ type: string, content: string }>, createdAt: number }

type OAuthState = {
  accessToken: string
  refreshToken?: string
  idToken?: string
  accountId?: string
  planType?: string
}

type TurnRuntimeState = {
  turnId: string
  assistantTextChunks: string[]
  messageTextByItemId: Map<string, string>
  thinkingOpen: boolean
  thinkingStartedAt: number | null
  thinkingTextByItemId: Map<string, string>
  reasoningSummaryByItemId: Map<string, string[]>
  reasoningRawContentByItemId: Map<string, string[]>
  turnUsage: UsageBreakdown | null
  completed: boolean
  failed: boolean
  failedMessage?: string
  lastErrorMessage?: string
}

function toTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function text(value: unknown): string {
  return toTrimmedString(value) ?? ""
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

const serviceTierSetting = {
  pick(value: unknown): "fast" | "flex" | undefined {
    const tierValue = toTrimmedString(value)?.toLowerCase()
    if (tierValue === "fast" || tierValue === "flex") return tierValue
    return undefined
  },
}

const resumeTokenCodec = {
  encode(state: ResumeState) {
    return `${RESUME_TOKEN_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString("base64url")}`
  },
  parse(token: string | undefined): ResumeState | undefined {
    const tokenValue = text(token)
    if (!tokenValue.startsWith(RESUME_TOKEN_PREFIX)) return undefined

    try {
      const parsed = JSON.parse(Buffer.from(tokenValue.slice(RESUME_TOKEN_PREFIX.length), "base64url").toString("utf8"))
      const threadId = toTrimmedString(parsed?.threadId)
      if (parsed?.version !== 1 || !threadId) return undefined
      return {
        version: 1,
        threadId,
      }
    } catch {
      return undefined
    }
  },
}

const tokenClaims = {
  payload(token: string | undefined): Record<string, any> | undefined {
    const tokenValue = toTrimmedString(token)
    if (!tokenValue) return undefined

    try {
      const [, payload] = tokenValue.split(".")
      if (!payload) return undefined
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    } catch {
      return undefined
    }
  },
  expirationMs(token: string | undefined) {
    const payload = this.payload(token)
    return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined
  },
  accountId(idToken: string | undefined, accessToken: string | undefined): string | undefined {
    const payloads = [this.payload(idToken), this.payload(accessToken)]

    for (const payload of payloads) {
      const direct = toTrimmedString(payload?.account_id)
      if (direct) return direct

      const auth = payload?.["https://api.openai.com/auth"]
      const nested = toTrimmedString(auth?.chatgpt_account_id)
      if (nested) return nested
    }

    return undefined
  },
}

const oauthApiKey = {
  parse(rawApiKey: string | undefined): OAuthState | undefined {
    const tokenValue = text(rawApiKey)
    if (!tokenValue.startsWith("oauth:")) return undefined

    const [accessToken = "", refreshToken = "", idToken = ""] = tokenValue.slice("oauth:".length).split(":")
    const trimmedAccessToken = accessToken.trim()
    if (!trimmedAccessToken) return undefined

    return {
      accessToken: trimmedAccessToken,
      refreshToken: refreshToken.trim() || undefined,
      idToken: idToken.trim() || undefined,
      accountId: tokenClaims.accountId(idToken, accessToken),
    }
  },
  isFresh(accessToken: string | undefined, idToken: string | undefined) {
    const expiresAt = tokenClaims.expirationMs(accessToken) ?? tokenClaims.expirationMs(idToken)
    if (!expiresAt) return true
    return expiresAt - Date.now() > OPENAI_ACCESS_TOKEN_REFRESH_BUFFER_MS
  },
}

const openAIEndpoints = {
  apiBaseUrl(baseUrl: string | undefined) {
    const baseUrlValue = text(baseUrl).replace(/\/+$/, "")
    if (!baseUrlValue) return undefined
    if (baseUrlValue.endsWith(RESPONSES_PATH_SUFFIX)) return baseUrlValue.slice(0, -RESPONSES_PATH_SUFFIX.length)
    if (baseUrlValue.endsWith(OPENAI_V1_SUFFIX)) return baseUrlValue
    return `${baseUrlValue}${OPENAI_V1_SUFFIX}`
  },
  wantsCustomChatgptBaseUrl(baseUrl: string | undefined) {
    const value = text(baseUrl)
    if (!value) return false

    try {
      const url = new URL(value)
      return !["api.openai.com", "chatgpt.com", "www.chatgpt.com"].includes(url.hostname)
    } catch {
      return true
    }
  },
  chatgptBaseUrl(baseUrl: string | undefined) {
    const baseUrlValue = text(baseUrl).replace(/\/+$/, "")
    if (!baseUrlValue || !this.wantsCustomChatgptBaseUrl(baseUrlValue)) return undefined
    if (baseUrlValue.includes(CHATGPT_BACKEND_API_SUFFIX)) return baseUrlValue
    if (baseUrlValue.endsWith(OPENAI_V1_SUFFIX)) return `${baseUrlValue.slice(0, -OPENAI_V1_SUFFIX.length)}${CHATGPT_BACKEND_API_SUFFIX}`
    return `${baseUrlValue}${CHATGPT_BACKEND_API_SUFFIX}`
  },
}

async function exchangeOpenAIToken(params: Record<string, string>) {
  const response = await fetch(OPENAI_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": OPENAI_OAUTH_USER_AGENT,
    },
    body: new URLSearchParams(params),
  })

  const body = await response.text()
  let data: Record<string, any> = {}
  if (body.trim()) {
    try {
      data = JSON.parse(body)
    } catch {
      throw new Error(body || `OAuth token exchange failed (${response.status})`)
    }
  }

  if (!response.ok) {
    throw new Error(
      toTrimmedString(data?.error_description)
      ?? toTrimmedString(data?.error?.message)
      ?? toTrimmedString(data?.error)
      ?? body
      ?? `OAuth token exchange failed (${response.status})`,
    )
  }

  return data
}

async function refreshOAuthState(input: OAuthState) {
  if (!input.refreshToken) {
    return input
  }

  const data = await exchangeOpenAIToken({
    grant_type: "refresh_token",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    refresh_token: input.refreshToken,
    scope: OPENAI_OAUTH_REFRESH_SCOPES,
  })

  const accessToken = toTrimmedString(data?.access_token)
  if (!accessToken) {
    throw new Error("OpenAI OAuth refresh completed but no access token was returned.")
  }

  const refreshToken = toTrimmedString(data?.refresh_token) ?? input.refreshToken
  const idToken = toTrimmedString(data?.id_token) ?? input.idToken
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId: tokenClaims.accountId(idToken, accessToken) ?? input.accountId,
    planType: input.planType,
  } satisfies OAuthState
}

function schemaToJsonSchema(parameters: any) {
  if (parameters && typeof parameters === "object" && ("type" in parameters || "properties" in parameters)) {
    return parameters as Record<string, unknown>
  }
  const schema = z.toJSONSchema(parameters) as Record<string, unknown>
  if ("$schema" in schema) delete schema.$schema
  return schema
}

function basenameFromPath(input: string) {
  const unixPath = input.replaceAll("\\", "/")
  const parts = unixPath.split("/")
  return parts[parts.length - 1] || unixPath
}

function truncateText(input: string, maxLength = 8000) {
  if (input.length <= maxLength) return input
  return `${input.slice(0, maxLength)}\n... [truncated]`
}

function readIncrementalText(state: Map<string, string>, itemId: unknown, nextText: unknown) {
  const id = toTrimmedString(itemId)
  const textValue = typeof nextText === "string" ? nextText : ""
  if (!id || !textValue) return ""

  const previous = state.get(id) ?? ""
  if (!previous) {
    state.set(id, textValue)
    return textValue
  }
  if (textValue.startsWith(previous)) {
    const delta = textValue.slice(previous.length)
    state.set(id, textValue)
    return delta
  }

  state.set(id, textValue)
  return textValue
}

function ensureIndexedTextEntry(state: Map<string, string[]>, itemId: string, index: number) {
  const nextIndex = Number.isInteger(index) && index >= 0 ? index : 0
  const parts = [...(state.get(itemId) ?? [])]
  while (parts.length <= nextIndex) parts.push("")
  state.set(itemId, parts)
  return { parts, index: nextIndex }
}

function joinThinkingSections(parts: string[]) {
  const nonEmptyParts = parts
    .map((part) => typeof part === "string" ? part : "")
    .filter((part) => part.length > 0)
  return nonEmptyParts.join("\n\n")
}

function extractReasoningDisplayText(item: any) {
  const summary = joinThinkingSections(Array.isArray(item?.summary) ? item.summary : [])
  if (summary) return summary
  return joinThinkingSections(Array.isArray(item?.content) ? item.content : [])
}

function closeThinking(target: ChatAgentEvent[], state: TurnRuntimeState) {
  if (!state.thinkingOpen) return
  state.thinkingOpen = false
  const duration = state.thinkingStartedAt == null ? 0 : Math.max(0, Date.now() - state.thinkingStartedAt)
  state.thinkingStartedAt = null
  target.push({ type: "thinking.end", thinkingDuration: duration })
}

function emitThinkingSnapshot(target: ChatAgentEvent[], state: TurnRuntimeState, itemId: unknown, nextText: string) {
  const delta = readIncrementalText(state.thinkingTextByItemId, itemId, nextText)
  if (!delta) return
  if (!state.thinkingOpen) {
    state.thinkingOpen = true
    state.thinkingStartedAt = Date.now()
    target.push({ type: "thinking.start" })
  }
  target.push({ type: "thinking.delta", thinkingContent: delta })
}

const usageBreakdown = {
  fromWire(usage: any): UsageBreakdown | null {
    if (!usage || typeof usage !== "object") return null
    return {
      inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0) + Number(usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
      reasoningTokens: Number(usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? 0),
      cost: 0,
    }
  },
}

function pushErrorEvent(target: ChatAgentEvent[], state: TurnRuntimeState, message: string | undefined) {
  const error = toTrimmedString(message)
  if (!error || error === state.lastErrorMessage) return
  state.lastErrorMessage = error
  target.push({ type: "error", error })
}

function jsonRpcErrorMessage(error: any) {
  if (!error) return "Unknown JSON-RPC error"
  const message = toTrimmedString(error?.message) ?? toTrimmedString(error?.error?.message)
  return message ?? JSON.stringify(error)
}

function isJsonRpcResponse(message: any): message is JsonRpcResponseMessage {
  return !!message
    && (typeof message.id === "number" || typeof message.id === "string")
    && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))
}

function isJsonRpcRequest(message: any): message is JsonRpcRequestMessage {
  return !!message
    && (typeof message.id === "number" || typeof message.id === "string")
    && typeof message.method === "string"
    && !Object.prototype.hasOwnProperty.call(message, "result")
    && !Object.prototype.hasOwnProperty.call(message, "error")
}

function dynamicToolContentItemsFromResult(result: ToolExecutionResult): DynamicToolContentItem[] {
  const items: DynamicToolContentItem[] = []
  const output = text(result.output)
  if (output) {
    items.push({ type: "inputText", text: output })
  }

  for (const attachment of Array.isArray(result.attachments) ? result.attachments : []) {
    const imageUrl = toTrimmedString((attachment as any)?.image_url) ?? toTrimmedString((attachment as any)?.url)
    if (imageUrl) {
      items.push({ type: "inputImage", imageUrl })
    }
  }

  return items
}

function contentItemsToText(contentItems: any) {
  if (!Array.isArray(contentItems)) return ""
  return contentItems
    .map((item) => (
      item?.type === "inputText"
        ? String(item?.text ?? "")
        : item?.type === "inputImage"
          ? `[image] ${String(item?.imageUrl ?? "")}`
          : ""
    ))
    .filter(Boolean)
    .join("\n")
}

function firstPathFromFileChanges(changes: any[]) {
  for (const change of changes) {
    const candidate = toTrimmedString(change?.path)
      ?? toTrimmedString(change?.newPath)
      ?? toTrimmedString(change?.oldPath)
      ?? toTrimmedString(change?.filePath)
    if (candidate) return candidate
  }
  return undefined
}

function buildFileChangeTitle(item: any) {
  const changes = Array.isArray(item?.changes) ? item.changes : []
  if (changes.length === 0) return "file change"
  const first = firstPathFromFileChanges(changes)
  if (!first) return `file change +${Math.max(changes.length - 1, 0)}`
  const label = basenameFromPath(first)
  return changes.length === 1 ? label : `${label} +${changes.length - 1}`
}

function extractUserText(content: any) {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => (item?.type === "text" ? String(item?.text ?? "") : ""))
    .join("")
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private pending: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private closed = false
  private error: unknown = null

  push(item: T) {
    if (this.closed) return
    const waiter = this.pending.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  fail(error: unknown) {
    if (this.closed) return
    this.closed = true
    this.error = error
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()
      waiter?.reject(error)
    }
  }

  end() {
    if (this.closed) return
    this.closed = true
    while (this.pending.length > 0) {
      const waiter = this.pending.shift()
      waiter?.resolve({ value: undefined as T, done: true })
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift()!
      return { value, done: false }
    }
    if (this.error) throw this.error
    if (this.closed) return { value: undefined as T, done: true }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

class AppServerTransport {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly queue = new AsyncQueue<JsonRpcNotificationMessage | JsonRpcRequestMessage>()
  private readonly pendingResponses = new Map<number, {
    method: string
    resolve: (value: any) => void
    reject: (error: unknown) => void
  }>()
  private readonly stderrLines: string[] = []
  private nextRequestId = 1
  private initialized = false

  constructor(
    private readonly logger: Logger,
    private readonly codexHome: string,
  ) {}

  async start(cwd: string) {
    if (this.initialized) return

    const codexBin = this.resolveCodexBin()
    const child = spawnProcess(process.execPath, [codexBin, "app-server", "--listen", "stdio://"], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.child = child

    const stdout = createInterface({ input: child.stdout })
    const stderr = createInterface({ input: child.stderr })

    stdout.on("line", (line) => {
      let parsed: any
      try {
        parsed = JSON.parse(line)
      } catch {
        this.logger.warn("[CodexAgent] app-server stdout was not valid JSON", {
          line: truncateText(line, 400),
        })
        return
      }

      if (isJsonRpcResponse(parsed)) {
        const responseId = typeof parsed.id === "number" ? parsed.id : Number(parsed.id)
        const pending = this.pendingResponses.get(responseId)
        if (!pending) return
        this.pendingResponses.delete(responseId)
        if (parsed.error) {
          pending.reject(new Error(`${pending.method}: ${jsonRpcErrorMessage(parsed.error)}`))
        } else {
          pending.resolve(parsed.result)
        }
        return
      }

      if (parsed && typeof parsed.method === "string") {
        this.queue.push(parsed)
      }
    })

    stderr.on("line", (line) => {
      this.stderrLines.push(line)
      while (this.stderrLines.length > 30) {
        this.stderrLines.shift()
      }
    })

    const fail = (error: unknown) => {
      if (this.child === child) {
        this.child = null
      }
      this.initialized = false
      while (this.pendingResponses.size > 0) {
        const [id, pending] = this.pendingResponses.entries().next().value as [number, {
          method: string
          resolve: (value: any) => void
          reject: (error: unknown) => void
        }]
        this.pendingResponses.delete(id)
        pending.reject(error)
      }
      this.queue.fail(error)
    }

    child.once("error", (error) => {
      fail(error)
    })

    child.once("exit", (code, signal) => {
      const stderrTail = this.stderrLines.length > 0 ? `\n${this.stderrLines.join("\n")}` : ""
      fail(new Error(`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${stderrTail}`))
    })

    const initializeResult = await this.request("initialize", {
      clientInfo: OFFICIAL_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    })
    this.notify("initialized")
    this.initialized = true
    return initializeResult
  }

  async request(method: string, params?: any) {
    const child = this.child
    if (!child) {
      throw new Error("codex app-server is not running")
    }

    const id = this.nextRequestId++
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }

    const response = new Promise<any>((resolve, reject) => {
      this.pendingResponses.set(id, { method, resolve, reject })
    })

    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return await response
  }

  notify(method: string, params?: any) {
    const child = this.child
    if (!child) {
      throw new Error("codex app-server is not running")
    }

    const payload = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  respond(id: number | string, result: any) {
    const child = this.child
    if (!child) {
      throw new Error("codex app-server is not running")
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
  }

  respondError(id: number | string, code: number, message: string, data?: unknown) {
    const child = this.child
    if (!child) {
      throw new Error("codex app-server is not running")
    }
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    })}\n`)
  }

  async nextMessage(abortSignal?: AbortSignal) {
    if (!abortSignal) {
      const next = await this.queue.next()
      return next.done ? null : next.value
    }

    if (abortSignal.aborted) {
      throw new Error("Request aborted")
    }

    return await new Promise<JsonRpcNotificationMessage | JsonRpcRequestMessage | null>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error("Request aborted"))
      }

      abortSignal.addEventListener("abort", onAbort, { once: true })
      this.queue.next().then((result) => {
        abortSignal.removeEventListener("abort", onAbort)
        resolve(result.done ? null : result.value)
      }).catch((error) => {
        abortSignal.removeEventListener("abort", onAbort)
        reject(error)
      })
    })
  }

  async stop() {
    const child = this.child
    this.child = null
    this.initialized = false
    if (!child) return

    try {
      child.stdin.end()
    } catch {
      // Ignore stdin shutdown errors.
    }

    try {
      child.kill("SIGTERM")
    } catch {
      // Ignore child termination errors.
    }

    this.queue.end()
  }

  private resolveCodexBin() {
    try {
      return require.resolve("@openai/codex/bin/codex.js")
    } catch {
      throw new Error("Unable to resolve @openai/codex. Install it for @any-code/codex-agent first.")
    }
  }
}

export class CodexAgent implements IChatAgent {
  readonly name: string

  private readonly config: ChatAgentConfig
  private readonly logger: Logger
  private readonly eventHandlers = new Map<string, Array<(data: any) => void>>()
  private readonly fallbackSessionId: string
  private readonly history: HistoryMessage[] = []
  private readonly todos: Array<Record<string, unknown>> = []
  private readonly resumeState?: ResumeState

  private initialized = false
  private authenticated = false
  private transport: AppServerTransport | null = null
  private toolContext: any = null
  private workingDirectory = ""
  private customTools = new Map<string, RuntimeTool>()
  private lastEmittedResumeToken = ""
  private totalUsage: UsageBreakdown | null = null
  private lastThreadTokenUsage: any = null
  private activeThreadId: string | null = null
  private activeTurnId: string | null = null
  private abortController: AbortController | null = null
  private chatInProgress = false
  private stopRequested = false
  private oauthState: OAuthState | null = null

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.logger = config.logger ?? consoleLogger
    this.name = config.name || "Codex Agent"
    this.fallbackSessionId = `codex-${Date.now()}`
    this.resumeState = resumeTokenCodec.parse(config.sessionId)
  }

  get sessionId(): string {
    const threadId = this.activeThreadId ?? this.resumeState?.threadId
    return threadId ? resumeTokenCodec.encode({ version: 1, threadId }) : this.fallbackSessionId
  }

  async init(): Promise<void> {
    if (this.initialized) return
    await this.initializeRuntime()
    await this.ensureTransport()
    await this.authenticate()
    this.initialized = true
  }

  on(event: string, handler: (data: any) => void): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir
    if (this.toolContext) {
      this.toolContext.directory = dir
      this.toolContext.worktree = dir
    }
  }

  async getUsage(): Promise<any> {
    return this.totalUsage
  }

  async getContext(): Promise<any> {
    const total = this.lastThreadTokenUsage?.total ?? {}
    return {
      threadId: this.activeThreadId ?? this.resumeState?.threadId ?? null,
      contextUsed: Number(total.totalTokens ?? total.total_tokens ?? 0),
      compactionThreshold: Number(this.lastThreadTokenUsage?.modelContextWindow ?? this.lastThreadTokenUsage?.model_context_window ?? 0),
    }
  }

  async getSessionMessages(opts: { limit: number }): Promise<any> {
    await this.init()
    const limit = Math.max(0, opts?.limit ?? 50)
    const threadId = this.activeThreadId ?? this.resumeState?.threadId
    if (!threadId || !this.transport) {
      return this.history.slice(-limit)
    }

    try {
      const response = await this.transport.request("thread/read", {
        threadId,
        includeTurns: true,
      })
      const messages = this.mapThreadHistory(response?.thread?.turns)
      return messages.slice(-limit)
    } catch {
      return this.history.slice(-limit)
    }
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    await this.init()

    if (this.chatInProgress) {
      yield { type: "error", error: "Chat is already running for this session" }
      yield { type: "done" }
      return
    }

    this.chatInProgress = true
    this.stopRequested = false
    this.abortController = new AbortController()

    const createdAt = Date.now()
    this.history.push({
      id: `user-${createdAt}`,
      role: "user",
      text: input,
      createdAt,
    })

    const state: TurnRuntimeState = {
      turnId: "",
      assistantTextChunks: [],
      messageTextByItemId: new Map<string, string>(),
      thinkingOpen: false,
      thinkingStartedAt: null,
      thinkingTextByItemId: new Map<string, string>(),
      reasoningSummaryByItemId: new Map<string, string[]>(),
      reasoningRawContentByItemId: new Map<string, string[]>(),
      turnUsage: null,
      completed: false,
      failed: false,
    }

    try {
      const threadId = await this.ensureThread()
      const turnResponse = await this.transport!.request("turn/start", this.buildTurnStartParams(threadId, input))
      state.turnId = text(turnResponse?.turn?.id)
      this.activeTurnId = state.turnId || null

      if (!state.turnId) {
        throw new Error("turn/start did not return a turn id")
      }

      while (!state.completed) {
        const message = await this.transport!.nextMessage()
        if (!message) {
          throw new Error("codex app-server closed before turn completed")
        }

        const yielded = await this.handleStreamMessage(message, state)
        if (!this.stopRequested) {
          for (const event of yielded) {
            yield event
          }
        }
      }
    } catch (error: any) {
      if (!this.stopRequested) {
        yield {
          type: "error",
          error: toTrimmedString(error?.message) ?? String(error),
        }
      }
    } finally {
      if (state.thinkingOpen && !this.stopRequested) {
        const duration = state.thinkingStartedAt == null ? 0 : Math.max(0, Date.now() - state.thinkingStartedAt)
        state.thinkingOpen = false
        state.thinkingStartedAt = null
        yield { type: "thinking.end", thinkingDuration: duration }
      }

      this.activeTurnId = null
      this.abortController = null
      this.chatInProgress = false
    }

    const assistantText = state.assistantTextChunks.join("")
    if (assistantText) {
      this.history.push({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        parts: [{ type: "text", content: assistantText }],
        createdAt: Date.now(),
      })
    }

    if (!this.stopRequested) {
      if (state.turnUsage) {
        yield {
          type: "message.done",
          usage: state.turnUsage,
        }
      }
      yield { type: "done" }
    }
  }

  abort(): void {
    this.stopRequested = true

    if (this.transport && this.activeThreadId && this.activeTurnId) {
      void this.transport.request("turn/interrupt", {
        threadId: this.activeThreadId,
        turnId: this.activeTurnId,
      }).catch(() => {
        this.abortController?.abort()
      })
      return
    }

    this.abortController?.abort()
  }

  async destroy(): Promise<void> {
    this.stopRequested = true
    this.abortController?.abort()
    this.chatInProgress = false
    this.activeTurnId = null
    this.authenticated = false
    this.initialized = false

    if (this.transport) {
      await this.transport.stop()
      this.transport = null
    }

    this.customTools.clear()
    this.toolContext = null
    this.eventHandlers.clear()
  }

  private async initializeRuntime() {
    const codeAgentOptions = this.config.codeAgentOptions ?? {}
    const configuredDirectory = stringOrUndefined(codeAgentOptions.directory) ?? ""
    const configuredWorktree = stringOrUndefined(codeAgentOptions.worktree)
    const directory = this.workingDirectory || configuredDirectory
    const worktree = configuredWorktree ?? directory
    const dataPath = text(codeAgentOptions.dataPath) || process.cwd()

    const terminal = codeAgentOptions.terminal ?? this.config.terminal ?? {
      ensureRunning() {},
      write() { throw new Error("Terminal not available") },
      read() { return "" },
      exists() { return false },
    }

    const preview = codeAgentOptions.preview ?? this.config.preview ?? {
      setPreviewTarget() {
        throw new Error("Preview not available")
      },
    }

    this.toolContext = {
      directory,
      worktree,
      project: {
        id: "global",
        worktree,
      },
      fs: codeAgentOptions.fs,
      git: codeAgentOptions.git,
      shell: codeAgentOptions.shell,
      terminal,
      preview,
      search: codeAgentOptions.search,
      dataPath,
      containsPath: (filepath: string) => {
        const resolvedPath = resolvePath(filepath)
        return (worktree ? resolvedPath.startsWith(resolvePath(worktree)) : false)
          || resolvedPath.startsWith(resolvePath(dataPath))
      },
      config: (codeAgentOptions.config ?? {}) as Record<string, any>,
      settings: codeAgentOptions.settings ?? {},
      session: {
        updateTodo: async ({ todos }: { todos: Array<Record<string, unknown>> }) => {
          this.todos.splice(0, this.todos.length, ...(Array.isArray(todos) ? todos : []))
          this.emitEvent("todo.updated", { todos: this.todos })
        },
        getTodo: () => this.todos,
      },
      emit: (event: string, data?: any) => this.emitEvent(event, data),
    }

    this.customTools.clear()
    for (const toolDef of this.getCustomToolDefinitions(codeAgentOptions.tools)) {
      const initialized = await toolDef.init()
      this.customTools.set(toolDef.id, {
        id: toolDef.id,
        description: text(initialized.description),
        inputSchema: schemaToJsonSchema(initialized.parameters),
        execute: async (args: any, ctx: any) => {
          const rawResult = await initialized.execute(args, ctx)
          const output = typeof rawResult?.output === "string" ? rawResult.output : JSON.stringify(rawResult?.output ?? "")
          return {
            title: text(rawResult?.title) || toolDef.id,
            metadata: typeof rawResult?.metadata === "object" && rawResult.metadata ? rawResult.metadata : {},
            output,
            attachments: Array.isArray(rawResult?.attachments) ? rawResult.attachments : undefined,
            success: rawResult?.success !== false,
          }
        },
      })
    }
  }

  private async ensureTransport() {
    if (this.transport) return this.transport

    const codexHome = resolvePath(this.toolContext?.dataPath || process.cwd(), "codex-home")
    await fsPromises.mkdir(codexHome, { recursive: true })

    const transport = new AppServerTransport(this.logger, codexHome)
    await transport.start(this.toolContext?.directory || process.cwd())
    this.transport = transport
    return transport
  }

  private async authenticate() {
    if (this.authenticated) return
    const transport = await this.ensureTransport()
    const oauth = oauthApiKey.parse(this.config.apiKey)

    if (oauth) {
      const resolved = await this.resolveOAuthState(oauth)
      if (!resolved.accountId) {
        throw new Error("OAuth token is missing chatgpt account id.")
      }

      await transport.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: resolved.accessToken,
        chatgptAccountId: resolved.accountId,
        chatgptPlanType: resolved.planType ?? null,
      })

      this.oauthState = resolved
      this.authenticated = true
      return
    }

    const apiKey = text(this.config.apiKey)
    if (!apiKey) {
      throw new Error("API key is required")
    }

    await transport.request("account/login/start", {
      type: "apiKey",
      apiKey,
    })

    this.authenticated = true
  }

  private async resolveOAuthState(input: OAuthState) {
    if (oauthApiKey.isFresh(input.accessToken, input.idToken)) {
      return input
    }
    if (!input.refreshToken) {
      return input
    }
    return await refreshOAuthState(input)
  }

  private buildThreadConfigOverrides() {
    const oauth = oauthApiKey.parse(this.config.apiKey)
    const overrides: Record<string, unknown> = {}

    const openaiBaseUrl = openAIEndpoints.apiBaseUrl(this.config.baseUrl)
    if (!oauth && openaiBaseUrl) {
      overrides.openai_base_url = openaiBaseUrl
    }

    const chatgptBaseUrl = openAIEndpoints.chatgptBaseUrl(this.config.baseUrl)
    if (oauth && chatgptBaseUrl) {
      overrides.chatgpt_base_url = chatgptBaseUrl
    }

    return Object.keys(overrides).length > 0 ? overrides : undefined
  }

  private buildDynamicTools() {
    return Array.from(this.customTools.values()).map((tool) => ({
      name: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
  }

  private async ensureThread() {
    const transport = await this.ensureTransport()
    const threadConfig = this.buildThreadConfigOverrides()
    const cwd = this.workingDirectory || this.toolContext?.directory || undefined
    const model = text(this.config.model) || "gpt-5.4"
    const serviceTier = serviceTierSetting.pick(this.config.serviceTier)
    const dynamicTools = this.buildDynamicTools()

    if (this.activeThreadId) return this.activeThreadId

    if (this.resumeState?.threadId) {
      const response = await transport.request("thread/resume", {
        threadId: this.resumeState.threadId,
        model,
        modelProvider: "openai",
        ...(serviceTier ? { serviceTier } : {}),
        ...(cwd ? { cwd } : {}),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(threadConfig ? { config: threadConfig } : {}),
        persistExtendedHistory: true,
      })

      this.activeThreadId = text(response?.thread?.id) || this.resumeState.threadId
      this.emitResumeTokenIfNeeded()
      return this.activeThreadId
    }

    const response = await transport.request("thread/start", {
      model,
      modelProvider: "openai",
      ...(serviceTier ? { serviceTier } : {}),
      ...(cwd ? { cwd } : {}),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      ...(threadConfig ? { config: threadConfig } : {}),
      persistExtendedHistory: true,
    })

    const threadId = text(response?.thread?.id)
    if (!threadId) {
      throw new Error("thread/start did not return a thread id")
    }

    this.activeThreadId = threadId
    this.emitResumeTokenIfNeeded()
    return threadId
  }

  private buildTurnStartParams(threadId: string, input: string) {
    const cwd = this.workingDirectory || this.toolContext?.directory || undefined
    const effort = toTrimmedString(this.config.reasoningEffort)
    const serviceTier = serviceTierSetting.pick(this.config.serviceTier)

    return {
      threadId,
      input: [{
        type: "text",
        text: input,
        text_elements: [],
      }],
      ...(cwd ? { cwd } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(effort ? { effort: effort.toLowerCase() } : {}),
    }
  }

  private async handleStreamMessage(message: JsonRpcNotificationMessage | JsonRpcRequestMessage, state: TurnRuntimeState) {
    if (isJsonRpcRequest(message)) {
      await this.handleServerRequest(message)
      return []
    }

    const method = message.method
    const params = message.params ?? {}
    const yielded: ChatAgentEvent[] = []

    if (method === "thread/tokenUsage/updated" && text(params.threadId) === this.activeThreadId) {
      this.lastThreadTokenUsage = params.tokenUsage ?? null
      this.totalUsage = usageBreakdown.fromWire(params.tokenUsage?.total)
      if (text(params.turnId) === state.turnId) {
        state.turnUsage = usageBreakdown.fromWire(params.tokenUsage?.last)
      }
      return yielded
    }

    if (method === "turn/plan/updated" && text(params.threadId) === this.activeThreadId) {
      const plan = Array.isArray(params.plan) ? params.plan : []
      this.todos.splice(0, this.todos.length, ...plan.map((item: any) => ({
        content: text(item?.step),
        status: text(item?.status) || "pending",
      })))
      this.emitEvent("todo.updated", {
        explanation: text(params.explanation) || undefined,
        todos: this.todos,
      })
      return yielded
    }

    if (text(params.threadId) !== this.activeThreadId || (text(params.turnId) && text(params.turnId) !== state.turnId)) {
      return yielded
    }

    switch (method) {
      case "error":
        if (params?.willRetry) {
          this.logger.warn("[CodexAgent] app-server turn error; retrying", {
            threadId: text(params?.threadId),
            turnId: text(params?.turnId),
            error: toTrimmedString(params?.error?.message) ?? "Unknown app-server retryable error",
            additionalDetails: toTrimmedString(params?.error?.additionalDetails) ?? undefined,
          })
          break
        }
        pushErrorEvent(
          yielded,
          state,
          toTrimmedString(params?.error?.message)
            ?? toTrimmedString(params?.error?.additionalDetails)
            ?? "codex app-server error",
        )
        break

      case "item/started": {
        const item = params.item
        const itemId = text(item?.id)
        if (item?.type === "reasoning" && itemId) {
          state.reasoningSummaryByItemId.set(itemId, [])
          state.reasoningRawContentByItemId.set(itemId, [])
          if (!state.thinkingOpen) {
            state.thinkingOpen = true
            state.thinkingStartedAt = Date.now()
            yielded.push({ type: "thinking.start" })
          }
        }

        const toolEvent = this.mapToolStartEvent(item)
        if (toolEvent) yielded.push(toolEvent)
        break
      }

      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : ""
        if (!delta) break
        const itemId = text(params.itemId)
        closeThinking(yielded, state)
        if (itemId) {
          const current = state.messageTextByItemId.get(itemId) ?? ""
          state.messageTextByItemId.set(itemId, current + delta)
        }
        state.assistantTextChunks.push(delta)
        yielded.push({ type: "text.delta", content: delta })
        break
      }

      case "item/reasoning/summaryTextDelta": {
        const delta = typeof params.delta === "string" ? params.delta : ""
        if (!delta) break
        const itemId = text(params.itemId)
        if (!itemId) break
        const { parts, index } = ensureIndexedTextEntry(
          state.reasoningSummaryByItemId,
          itemId,
          Number(params.summaryIndex ?? params.summary_index ?? 0),
        )
        parts[index] += delta
        state.reasoningSummaryByItemId.set(itemId, parts)
        emitThinkingSnapshot(yielded, state, itemId, joinThinkingSections(parts))
        break
      }

      case "item/reasoning/summaryPartAdded": {
        const itemId = text(params.itemId)
        if (!itemId) break
        ensureIndexedTextEntry(
          state.reasoningSummaryByItemId,
          itemId,
          Number(params.summaryIndex ?? params.summary_index ?? 0),
        )
        break
      }

      case "item/reasoning/textDelta": {
        const delta = typeof params.delta === "string" ? params.delta : ""
        if (!delta) break
        const itemId = text(params.itemId)
        if (!itemId) break
        const { parts, index } = ensureIndexedTextEntry(
          state.reasoningRawContentByItemId,
          itemId,
          Number(params.contentIndex ?? params.content_index ?? 0),
        )
        parts[index] += delta
        state.reasoningRawContentByItemId.set(itemId, parts)
        break
      }

      case "item/completed": {
        const item = params.item
        if (item?.type === "reasoning") {
          const itemId = text(item?.id)
          const visibleText = extractReasoningDisplayText(item)
            || joinThinkingSections(state.reasoningSummaryByItemId.get(itemId) ?? [])
            || joinThinkingSections(state.reasoningRawContentByItemId.get(itemId) ?? [])
          if (visibleText) {
            emitThinkingSnapshot(yielded, state, itemId, visibleText)
          }
          state.reasoningSummaryByItemId.delete(itemId)
          state.reasoningRawContentByItemId.delete(itemId)
          closeThinking(yielded, state)
          break
        }

        if (item?.type === "agentMessage") {
          const itemId = text(item?.id)
          const delta = readIncrementalText(state.messageTextByItemId, itemId, item?.text)
          if (delta) {
            closeThinking(yielded, state)
            state.assistantTextChunks.push(delta)
            yielded.push({ type: "text.delta", content: delta })
          }
          break
        }

        const toolEvent = this.mapToolCompletedEvent(item)
        if (toolEvent) yielded.push(toolEvent)
        break
      }

      case "turn/completed": {
        state.completed = true
        closeThinking(yielded, state)

        const turn = params.turn ?? {}
        const status = text(turn.status)
        if (status === "failed") {
          state.failed = true
          state.failedMessage = toTrimmedString(turn?.error?.message) ?? "Turn failed"
          pushErrorEvent(yielded, state, state.failedMessage)
        }
        break
      }

      default:
        break
    }

    return yielded
  }

  private mapToolStartEvent(item: any): ChatAgentEvent | null {
    if (!item || typeof item !== "object") return null

    switch (item.type) {
      case "dynamicToolCall":
        return {
          type: "tool.start",
          toolCallId: text(item.id),
          toolName: text(item.tool),
          toolArgs: item.arguments ?? {},
        }

      case "commandExecution":
        return {
          type: "tool.start",
          toolCallId: text(item.id),
          toolName: "shell_command",
          toolArgs: {
            command: text(item.command),
            cwd: text(item.cwd),
          },
          toolTitle: text(item.command) || "shell command",
        }

      case "fileChange":
        return {
          type: "tool.start",
          toolCallId: text(item.id),
          toolName: "apply_patch",
          toolArgs: {
            changes: Array.isArray(item.changes) ? item.changes : [],
          },
          toolTitle: buildFileChangeTitle(item),
        }

      case "webSearch":
        return {
          type: "tool.start",
          toolCallId: text(item.id),
          toolName: "web_search",
          toolArgs: {
            query: text(item.query),
          },
          toolTitle: text(item.query) || "web search",
        }

      case "imageView":
        return {
          type: "tool.start",
          toolCallId: text(item.id),
          toolName: "view_image",
          toolArgs: {
            path: text(item.path),
          },
          toolTitle: basenameFromPath(text(item.path) || "image"),
        }

      default:
        return null
    }
  }

  private mapToolCompletedEvent(item: any): ChatAgentEvent | null {
    if (!item || typeof item !== "object") return null

    switch (item.type) {
      case "dynamicToolCall": {
        const output = contentItemsToText(item.contentItems)
        const success = item.success !== false && text(item.status) !== "failed"
        return success
          ? {
            type: "tool.done",
            toolCallId: text(item.id),
            toolName: text(item.tool),
            toolOutput: output,
            toolDuration: Number(item.durationMs ?? 0),
            toolMetadata: {
              status: item.status,
              success: item.success,
            },
          }
          : {
            type: "tool.error",
            toolCallId: text(item.id),
            toolName: text(item.tool),
            error: output || text(item.status) || "Dynamic tool failed",
            toolDuration: Number(item.durationMs ?? 0),
          }
      }

      case "commandExecution": {
        const status = text(item.status)
        const eventBase = {
          toolCallId: text(item.id),
          toolName: "shell_command",
          toolDuration: Number(item.durationMs ?? 0),
          toolTitle: text(item.command) || "shell command",
        }
        return status === "completed"
          ? {
            type: "tool.done",
            ...eventBase,
            toolOutput: text(item.aggregatedOutput),
            toolMetadata: {
              cwd: text(item.cwd),
              exitCode: item.exitCode,
              processId: toTrimmedString(item.processId),
              status,
            },
          }
          : {
            type: "tool.error",
            ...eventBase,
            error: text(item.aggregatedOutput) || status || "shell command failed",
          }
      }

      case "fileChange": {
        const status = text(item.status)
        const title = buildFileChangeTitle(item)
        const output = truncateText(JSON.stringify(item.changes ?? []), 4000)
        return status === "completed"
          ? {
            type: "tool.done",
            toolCallId: text(item.id),
            toolName: "apply_patch",
            toolOutput: output,
            toolTitle: title,
            toolMetadata: {
              status,
              changes: item.changes ?? [],
            },
          }
          : {
            type: "tool.error",
            toolCallId: text(item.id),
            toolName: "apply_patch",
            error: status || "apply_patch failed",
            toolTitle: title,
          }
      }

      case "webSearch":
        return {
          type: "tool.done",
          toolCallId: text(item.id),
          toolName: "web_search",
          toolOutput: text(item.query),
          toolTitle: text(item.query) || "web search",
          toolMetadata: {
            action: item.action ?? null,
          },
        }

      case "imageView":
        return {
          type: "tool.done",
          toolCallId: text(item.id),
          toolName: "view_image",
          toolOutput: text(item.path),
          toolTitle: basenameFromPath(text(item.path) || "image"),
          toolMetadata: {
            path: text(item.path),
          },
        }

      default:
        return null
    }
  }

  private async handleServerRequest(message: JsonRpcRequestMessage) {
    switch (message.method) {
      case "item/tool/call":
        await this.handleDynamicToolCallRequest(message)
        return

      case "account/chatgptAuthTokens/refresh":
        await this.handleChatgptAuthTokensRefresh(message)
        return

      default:
        this.transport?.respondError(message.id, -32601, `Unsupported server request: ${message.method}`)
    }
  }

  private async handleDynamicToolCallRequest(message: JsonRpcRequestMessage) {
    const params = message.params ?? {}
    const toolName = text(params.tool)
    const tool = this.customTools.get(toolName)

    if (!tool) {
      this.transport?.respond(message.id, {
        contentItems: [{ type: "inputText", text: `Unknown dynamic tool: ${toolName}` }],
        success: false,
      })
      return
    }

    let titleOverride = ""
    let metadataOverride: Record<string, unknown> = {}
    const toolDirectory = this.workingDirectory || this.toolContext?.directory || ""
    const toolWorktree = this.workingDirectory || this.toolContext?.worktree || toolDirectory

    try {
      const result = await tool.execute(params.arguments ?? {}, {
        ...this.toolContext,
        directory: toolDirectory,
        worktree: toolWorktree,
        sessionID: this.activeThreadId,
        messageID: `tool-${randomUUID()}`,
        agent: "codex",
        abort: this.abortController?.signal,
        callID: text(params.callId) || text(params.id),
        messages: [],
        metadata: (input: { title?: string, metadata?: Record<string, unknown> }) => {
          if (input.title) titleOverride = input.title
          if (input.metadata) metadataOverride = { ...metadataOverride, ...input.metadata }
        },
        ask: async () => {},
        emit: (event: string, data?: any) => this.emitEvent(event, data),
      })

      const toolResult: ToolExecutionResult = {
        title: result.title || titleOverride || toolName,
        metadata: { ...metadataOverride, ...(result.metadata ?? {}) },
        output: result.output,
        attachments: result.attachments,
        success: result.success !== false,
      }

      this.transport?.respond(message.id, {
        contentItems: dynamicToolContentItemsFromResult(toolResult),
        success: toolResult.success !== false,
      })
    } catch (error: any) {
      this.transport?.respond(message.id, {
        contentItems: [{
          type: "inputText",
          text: toTrimmedString(error?.message) ?? String(error),
        }],
        success: false,
      })
    }
  }

  private async handleChatgptAuthTokensRefresh(message: JsonRpcRequestMessage) {
    if (!this.oauthState) {
      this.transport?.respondError(message.id, -32603, "ChatGPT OAuth refresh requested but external auth is not configured.")
      return
    }

    try {
      this.oauthState = await refreshOAuthState(this.oauthState)
      if (!this.oauthState.accountId) {
        throw new Error("Refreshed OAuth token is missing chatgpt account id.")
      }

      this.transport?.respond(message.id, {
        accessToken: this.oauthState.accessToken,
        chatgptAccountId: this.oauthState.accountId,
        chatgptPlanType: this.oauthState.planType ?? null,
      })
    } catch (error: any) {
      this.transport?.respondError(message.id, -32603, toTrimmedString(error?.message) ?? String(error))
    }
  }

  private getCustomToolDefinitions(rawTools: unknown) {
    if (!Array.isArray(rawTools)) return []
    return rawTools.filter((tool): tool is ExternalToolDefinition => (
      !!tool
      && typeof (tool as ExternalToolDefinition).id === "string"
      && CUSTOM_TOOL_IDS.has((tool as ExternalToolDefinition).id)
      && typeof (tool as ExternalToolDefinition).init === "function"
    ))
  }

  private mapThreadHistory(turns: any[]): HistoryMessage[] {
    if (!Array.isArray(turns)) return this.history

    const messages: HistoryMessage[] = []
    let order = 1

    for (const turn of turns) {
      if (!Array.isArray(turn?.items)) continue
      for (const item of turn.items) {
        if (item?.type === "userMessage") {
          const content = extractUserText(item?.content)
          if (!content) continue
          messages.push({
            id: text(item?.id) || `user-${order}`,
            role: "user",
            text: content,
            createdAt: order,
          })
          order += 1
          continue
        }

        if (item?.type === "agentMessage") {
          const content = text(item?.text)
          if (!content) continue
          messages.push({
            id: text(item?.id) || `assistant-${order}`,
            role: "assistant",
            parts: [{ type: "text", content }],
            createdAt: order,
          })
          order += 1
          continue
        }

        if (item?.type === "reasoning") {
          const content = extractReasoningDisplayText(item)
          if (!content) continue
          messages.push({
            id: text(item?.id) || `assistant-${order}`,
            role: "assistant",
            parts: [{ type: "thinking", content }],
            createdAt: order,
          })
          order += 1
        }
      }
    }

    return messages.length > 0 ? messages : this.history
  }

  private emitEvent(event: string, data: any) {
    const handlers = this.eventHandlers.get(event) ?? []
    for (const handler of handlers) {
      handler(data)
    }
  }

  private emitResumeTokenIfNeeded() {
    if (!this.activeThreadId) return
    const token = resumeTokenCodec.encode({ version: 1, threadId: this.activeThreadId })
    if (token === this.lastEmittedResumeToken) return
    this.lastEmittedResumeToken = token
    this.emitEvent("cascade.created", { cascadeId: token })
  }
}
