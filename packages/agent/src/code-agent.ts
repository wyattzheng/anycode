/**
 * CodeAgent - AnyCode's AI Coding Agent
 *
 * A clean wrapper around opencode's core agent-loop.
 * Supports custom prompts, tools, and LLM provider configuration.
 *
 * @example
 * ```ts
 * import { CodeAgent } from "@any-code/agent/agent/code-agent"
 *
 * const agent = new CodeAgent({
 *   directory: "/path/to/project",
 *   provider: { id: "anthropic", apiKey: "sk-...", model: "claude-sonnet-4-20250514" },
 *   systemPrompt: "You are AnyCode's AI assistant...",
 * })
 *
 * await agent.init()
 * const stream = agent.chat("Build a React todo app")
 * for await (const event of stream) {
 *   console.log(event)
 * }
 * ```
 */

import * as path from "./util/path"
import type { AgentContext, ShellProvider, TerminalProvider, PreviewProvider } from "./context"
import type { Project } from "./project"
import type { VFS } from "./util/vfs"
import type { SearchProvider } from "./util/search"
import type { GitProvider } from "./util/git"
import { EnvService } from "./util/env"
import { EventEmitter } from "events"
import { SchedulerService } from "./util/scheduler"
import { FileTimeService } from "./project"
import { Database } from "./storage"
import { Log } from "./util/log"
import { ToolRegistry } from "./tool/registry"
import { Tool } from "./tool/tool"
import { Session, SessionService } from "./session"
import { SessionPrompt } from "./session/session"
import { MessageV2 } from "./memory/message-v2"
import { MemoryService } from "./memory"
import type { Settings } from "./settings"
import { Provider } from "@any-code/provider"

import { SkillService } from "./skill"
import type { Logger } from "@any-code/utils"
import { NamedError } from "./util/error"
import { defer } from "./util/fn"
import { ulid } from "ulid"
import { MessageID as MsgID, SessionID } from "./session/schema"
import { SystemPrompt } from "./prompt"
import { ContextCompaction } from "./memory/compaction"
import { LLMRunner } from "./llm-runner"

// ── Types ──────────────────────────────────────────────────────────────────

export interface CodeAgentProvider {
    /** Provider ID, e.g. "anthropic", "openai", "google" */
    id: string
    /** Model ID, e.g. "claude-sonnet-4-20250514", "gpt-4o" */
    model: string
    /** API key for the provider */
    apiKey: string
    /** Optional base URL override (for proxies or compatible APIs) */
    baseUrl?: string
    /** Model pricing in USD per million tokens */
    cost?: {
        input: number
        output: number
        cacheRead?: number
        cacheWrite?: number
    }
}



/**
 * StorageProvider — abstraction over the database backend.
 */
export interface StorageProvider {
    connect(migrations: Migration[]): Promise<any>
    close(): void
}

export interface Migration {
    sql: string
    timestamp: number
    name: string
}

export interface CodeAgentOptions {
    /** Working directory for the agent */
    directory: string

    /** LLM provider configuration */
    provider: CodeAgentProvider

    /** Custom system prompt (appended to the default prompt) */
    systemPrompt?: string

    /**
     * Pre-built configuration object.
     * When provided, bypasses all filesystem-based config loading
     * (opencode.json, .opencode/ directories, etc.).
     * Should conform to opencode's config schema.
     */
    config?: Record<string, unknown>

    /**
     * Attach to an existing session instead of creating a new one.
     * When set, init() will resume this session ID rather than
     * calling session.create().
     */
    sessionId?: string

    /**
     * Virtual File System implementation.
     * Required — provides file I/O for all tool operations.
     */
    fs: VFS

    /**
     * Search Provider implementation.
     * Abstracted from VFS to separate file I/O from complex CLI tasks (grep/list).
     */
    search: SearchProvider

    /**
     * Pre-built instruction texts.
     * When provided, bypasses AGENTS.md / CLAUDE.md file reading.
     * Each string is a complete instruction block.
     */
    instructions?: string[]

    /**
     * Storage provider for the database backend.
     * Defaults to BetterSqliteStorage (file-based) if not provided.
     */
    storage?: StorageProvider

    /**
     * Base data directory for this agent instance.
     * Used for tool output, plans, skills cache, models cache, etc.
     */
    dataPath: string

    /** Override project metadata (discovered from directory if not provided) */
    project?: Project.Info

    /** Pre-resolved root worktree directory. Defaults to directory. */
    worktree?: string

    /**
     * Git command executor.
     * Must be provided by the host (e.g. NodeGitProvider in agent/).
     */
    git: GitProvider

    /**
     * Shell execution provider (spawn/kill).
     * Required — provides process execution for the bash tool.
     */
    shell: ShellProvider

    /**
     * User settings (from ~/.anycode/settings.json or equivalent).
     * Loaded by the host and injected here. Contains hooks, env, etc.
     */
    settings?: Settings.Info

    /**
     * Terminal provider for agent ↔ user shared PTY.
     * Optional — when not provided, terminal tools will throw errors.
     */
    terminal?: TerminalProvider

    /**
     * Preview provider for setting reverse proxy URLs.
     * Optional — when not provided, set_preview_url tool will throw errors.
     */
    preview?: PreviewProvider

    /**
     * Custom tools to register.
     * Passed through to ToolRegistryService for inclusion in tool list.
     */
    tools?: Tool.Info[]

    /**
     * Logger implementation.
     * Optional — when not provided, falls back to console.
     */
    logger?: Logger
}

export interface CodeAgentSession {
    id: string
    title: string
    createdAt: number
}

export type CodeAgentEventType =
    // ── Lifecycle ──
    | "session.status"      // session 状态变更 (idle/busy/compacting)
    // ── Thinking ──
    | "thinking.start"      // 思考开始
    | "thinking.delta"      // 思考内容增量
    | "thinking.end"        // 思考结束（含耗时）
    // ── Text ──
    | "text.delta"          // 文本输出增量
    // ── Tool ──
    | "tool.start"          // tool 调用开始（含 name + args）
    | "tool.delta"          // tool 执行中间输出（可选）
    | "tool.done"           // tool 完成（含 output + metadata）
    | "tool.error"          // tool 失败
    // ── Message ──
    | "message.start"       // 新的 assistant message 开始
    | "message.done"        // message 完成（含 usage / cost）
    // ── Control ──
    | "error"               // 全局错误
    | "done"                // 整个 chat 结束

export interface CodeAgentEvent {
    type: CodeAgentEventType

    /** text.delta: incremental text */
    content?: string

    /** thinking.*: incremental thinking text */
    thinkingContent?: string
    /** thinking.end: duration in ms */
    thinkingDuration?: number

    /** tool.*: tool call ID for correlating start/done/error */
    toolCallId?: string
    /** tool.*: tool name */
    toolName?: string
    /** tool.start: tool input arguments */
    toolArgs?: Record<string, unknown>
    /** tool.done: tool output text */
    toolOutput?: string
    /** tool.done: tool title (human-readable summary) */
    toolTitle?: string
    /** tool.done: tool metadata */
    toolMetadata?: Record<string, unknown>
    /** tool.done/error: duration in ms */
    toolDuration?: number

    /** session.status: current status */
    status?: string

    /** error: error message */
    error?: string

    /** message.done / done: token usage and cost */
    usage?: {
        inputTokens: number
        outputTokens: number
        reasoningTokens: number
        cost: number
    }
}

// ── CodeAgent Class ────────────────────────────────────────────────────────

export class CodeAgent extends EventEmitter {
    private options: CodeAgentOptions
    private initialized = false
    private _currentSessionId: string | null = null
    private _providerId!: string
    private _modelId!: string
    private _storageProvider: StorageProvider | undefined
    private _dbClient: any
    private _git: GitProvider
    private _context!: AgentContext

    /** Promise that resolves when the current chat() finishes (for abort await) */
    private _chatPromise: Promise<void> | null = null



    // ── Phase 0: stateless services (no context dependency) ──────
    readonly env: EnvService
    readonly scheduler: SchedulerService
    readonly fileTime: FileTimeService

    readonly log: Log

    constructor(options: CodeAgentOptions) {
        super()
        this.options = options
        this._git = options.git
        this.setMaxListeners(100)

        // Create stateless services
        this.env = new EnvService()
        this.scheduler = new SchedulerService()
        this.fileTime = new FileTimeService()
        this.log = new Log({ logger: options.logger })
    }

    /**
     * The virtual file system instance.
     */
    get fs(): VFS {
        return this.options.fs
    }

    /**
     * Get the opencode AgentContext representation.
     * Cached as a single instance after init().
     */
    get agentContext(): AgentContext {
        return this._context
    }

    /**
     * Change the working directory for this agent instance.
     * Mutates internal context (directory, worktree, project, containsPath).
     * Pass empty string to clear the directory (allows re-setting later).
     */
    setWorkingDirectory(dir: string) {
        const current = this.options.directory
        // Clearing: allow anytime
        if (!dir || dir === "") {
            this.options.directory = ""
            this.options.worktree = ""
            if (this._context) {
                ; (this._context as any).directory = ""
                    ; (this._context as any).worktree = ""
            }
            return
        }
        // Setting: only if currently unset (empty string)
        if (current && current !== "") {
            throw new Error(`Working directory already set to "${current}". Clear it first by setting to empty string.`)
        }
        this.options.directory = dir
        this.options.worktree = dir
        if (this._context) {
            ; (this._context as any).directory = dir
                ; (this._context as any).worktree = dir
                ; (this._context as any).project = { ...this._context.project, worktree: dir }
                ; (this._context as any).containsPath = (filepath: string) => {
                    const normalized = path.resolve(filepath)
                    return normalized.startsWith(path.resolve(dir)) ||
                        normalized.startsWith(path.resolve(this.options.dataPath))
                }
        }
    }

    /**
     * Initialize the agent - must be called before chat.
     * Boots up opencode subsystems: database, config, plugins, tool registry,
     * and constructs all service instances.
     */
    async init(): Promise<void> {
        if (this.initialized) return

        const p = this.options.provider
        this._providerId = p.id
        this._modelId = p.model

        // Set provider API key via environment variable (opencode convention)
        const envKey = this.getProviderEnvKey(p.id)
        if (envKey) {
            this.env.set(envKey, p.apiKey)
        }

        // Set base URL if provided
        if (p.baseUrl) {
            const baseUrlEnv = this.getProviderBaseUrlEnv(p.id)
            if (baseUrlEnv) {
                this.env.set(baseUrlEnv, p.baseUrl)
            }
        }

        const migrations = Database.getMigrations()

        if (!this.options.storage) {
            throw new Error("CodeAgent requires a storage provider. Pass a StorageProvider via options.storage.")
        }
        this._storageProvider = this.options.storage
        this._dbClient = await this._storageProvider.connect(migrations)

        // ── Build context with all services ──────────────────────────
        const worktree = this.options.worktree ?? this.options.directory
        const ctx = {
            directory: this.options.directory,
            worktree,
            project: (this.options.project ?? { id: "global", worktree }) as any,
            fs: this.options.fs as any,
            git: this._git as any,
            shell: this.options.shell,
            terminal: this.options.terminal ?? {
                create() { throw new Error("Terminal not available in this environment.") },
                destroy() { throw new Error("Terminal not available in this environment.") },
                write() { throw new Error("Terminal not available in this environment.") },
                read() { throw new Error("Terminal not available in this environment.") },
                exists() { return false },
            },
            preview: this.options.preview ?? {
                setPreviewTarget() { throw new Error("Preview not available in this environment.") },
            },
            search: this.options.search as any,
            dataPath: this.options.dataPath,
            configOverrides: this.options.config as any,
            instructions: this.options.instructions,
            db: this._dbClient,
            tools: [...(this.options.tools ?? [])],
            containsPath: (filepath: string) => {
                const normalized = path.resolve(filepath)
                return normalized.startsWith(path.resolve(worktree)) ||
                    normalized.startsWith(path.resolve(this.options.dataPath))
            },
            // Phase 0: stateless services
            env: this.env,
            session: undefined as any, // will be set below
            scheduler: this.scheduler,
            fileTime: this.fileTime,
            memory: undefined as any, // will be set below after ctx is created
            log: this.log,
        } as AgentContext

        // Create MemoryService (needs ctx reference)
        ctx.memory = new MemoryService(ctx)

        // Create SessionService and forward its events → CodeAgent
        ctx.session = new SessionService(ctx)
        for (const evt of ["session.updated", "session.created", "session.status", "session.error", "session.compacted", "todo.updated"]) {
            ctx.session.on(evt, (data: any) => this.emit(evt, data))
        }

        // Forward MemoryService events → CodeAgent EventEmitter
        ctx.memory.on("message.updated", (data: any) => this.emit("message.updated", data))
        ctx.memory.on("message.removed", (data: any) => this.emit("message.removed", data))
        ctx.memory.on("message.part.updated", (data: any) => this.emit("message.part.updated", data))
        ctx.memory.on("message.part.removed", (data: any) => this.emit("message.part.removed", data))
        ctx.memory.on("message.part.delta", (data: any) => this.emit("message.part.delta", data))

        // Phase 1: context-dependent services
        ctx.config = (this.options.config ?? {}) as Record<string, any>
        ctx.settings = this.options.settings ?? {}
        ctx.sessionStatus = { type: "idle" }

        ctx.sessionPrompt = new SessionPrompt.SessionPromptService()
        ctx.systemPrompt = new SystemPrompt()



        ctx.provider = new Provider.ProviderService(ctx, this.options.provider)
        ctx.toolRegistry = new ToolRegistry.ToolRegistryService(ctx)
        ctx.skill = new SkillService(ctx)

        ctx.provider.bind(ctx)

        this._context = ctx



        // Ensure the global project exists in DB
        if (!this._dbClient.findOne("project", { op: "eq", field: "id", value: "global" })) {
            this._dbClient.insert("project", {
                id: "global" as any,
                worktree: "/",
                vcs: null,
                sandboxes: [],
                time_created: Date.now(),
                time_updated: Date.now()
            })
        }

        // If a custom project was provided, ensure it exists in DB too (FK constraint)
        if (this.options.project && this.options.project.id !== "global") {
            const pid = this.options.project.id
            if (!this._dbClient.findOne("project", { op: "eq", field: "id", value: pid })) {
                this._dbClient.insert("project", {
                    id: pid,
                    worktree: this.options.project.worktree ?? "/",
                    vcs: (this.options.project as any).vcs ?? null,
                    sandboxes: (this.options.project as any).sandboxes ?? [],
                    time_created: Date.now(),
                    time_updated: Date.now()
                })
            }
        }

        this.initialized = true

        // Resume existing session or create a new one
        const session = await this._context.session.getOrCreate(this.options.sessionId)
        this._currentSessionId = session.id
    }

    /**
     * Current session ID.
     */
    get sessionId(): string {
        this.assertInitialized()
        return this._currentSessionId!
    }

    /**
     * Send a message to the agent and receive streaming responses.
     */
    async *chat(
        message: string,
        options?: { chatId?: string },
    ): AsyncGenerator<CodeAgentEvent> {
        this.assertInitialized()
        if (this._chatPromise) {
            throw new Error('chat() is already running. Call abort() and await it first.')
        }
        const sessionId = this._currentSessionId!

        // Use caller-provided chatId or auto-generate one
        const chatId = options?.chatId ?? ulid()

        // Set up event stream
        const events: CodeAgentEvent[] = []
        let resolve: (() => void) | null = null
        let done = false
        let chatResolve!: () => void
        this._chatPromise = new Promise<void>(r => { chatResolve = r })

        const push = (event: CodeAgentEvent) => {
            events.push(event)
            if (resolve) {
                resolve()
                resolve = null
            }
        }

        // Start the agent loop in the background
        const promptPromise = (async () => {
            // Subscribe to message part events
            const unsubs: (() => void)[] = []

            try {
                // Track partID → part type for routing deltas
                const partTypeMap = new Map<string, "reasoning" | "text">()

                // Subscribe to all events on this instance's bus
                const globalHandler = (payload: any) => {
                    if (!payload) return
                    const type = payload.type
                    const props = payload.properties

                    // ── PartDelta: route to thinking.delta or text.delta ──
                    if (type === "message.part.delta") {
                        const partType = partTypeMap.get(props.partID)
                        if (partType === "reasoning") {
                            push({
                                type: "thinking.delta",
                                thinkingContent: props.delta,
                            })
                        } else {
                            push({
                                type: "text.delta",
                                content: props.delta,
                            })
                        }
                    }

                    // ── PartUpdated: reasoning / text / tool / step-finish ──
                    if (type === "message.part.updated") {
                        const part = props?.part
                        if (!part) return

                        // Reasoning parts
                        if (part.type === "reasoning") {
                            partTypeMap.set(part.id, "reasoning")
                            if (!part.time?.end) {
                                push({ type: "thinking.start" })
                            } else {
                                const duration = part.time.end - part.time.start
                                push({
                                    type: "thinking.end",
                                    thinkingDuration: duration,
                                })
                                partTypeMap.delete(part.id)
                            }
                        }

                        // Text parts — register for delta routing
                        if (part.type === "text") {
                            partTypeMap.set(part.id, "text")
                        }

                        // Tool parts
                        if (part.type === "tool" && part.state.status === "running") {
                            push({
                                type: "tool.start",
                                toolCallId: part.callID,
                                toolName: part.tool,
                                toolArgs: part.state.input as Record<string, unknown>,
                                toolTitle: part.state.title,
                            })
                        }
                        if (part.type === "tool" && part.state.status === "completed") {
                            const duration = part.state.time?.end && part.state.time?.start
                                ? part.state.time.end - part.state.time.start
                                : undefined
                            push({
                                type: "tool.done",
                                toolCallId: part.callID,
                                toolName: part.tool,
                                toolOutput: part.state.output,
                                toolTitle: part.state.title,
                                toolMetadata: part.state.metadata,
                                toolDuration: duration,
                            })
                        }
                        if (part.type === "tool" && part.state.status === "error") {
                            const duration = part.state.time?.end && part.state.time?.start
                                ? part.state.time.end - part.state.time.start
                                : undefined
                            push({
                                type: "tool.error",
                                toolCallId: part.callID,
                                toolName: part.tool,
                                error: part.state.error,
                                toolDuration: duration,
                            })
                        }

                        // Step finish — token usage and cost
                        if (part.type === "step-finish") {
                            push({
                                type: "message.done",
                                usage: {
                                    inputTokens: part.tokens.input,
                                    outputTokens: part.tokens.output,
                                    reasoningTokens: part.tokens.reasoning,
                                    cost: part.cost,
                                },
                            })
                        }
                    }


                    // ── Session status ──
                    if (type === "session.status") {
                        push({
                            type: "session.status",
                            status: props.status?.type ?? "idle",
                        })
                    }

                    // ── Session error ──
                    if (type === "session.error") {
                        const errorMsg = props.error?.data?.message || props.error?.message || "Unknown error";
                        push({
                            type: "error",
                            error: errorMsg,
                        })
                    }
                }

                const h1 = (data: any) => globalHandler({ type: "message.part.delta", properties: data })
                const h2 = (data: any) => globalHandler({ type: "message.part.updated", properties: data })
                const h3 = (data: any) => globalHandler({ type: "session.status", properties: data })
                const h4 = (data: any) => globalHandler({ type: "session.error", properties: data })
                this._context.memory.on("message.part.delta", h1)
                this._context.memory.on("message.part.updated", h2)
                this._context.session.on("session.status", h3)
                this._context.session.on("session.error", h4)
                unsubs.push(() => {
                    this._context.memory.removeListener("message.part.delta", h1)
                    this._context.memory.removeListener("message.part.updated", h2)
                    this._context.session.removeListener("session.status", h3)
                    this._context.session.removeListener("session.error", h4)
                })


                const providerID = this._providerId
                const modelID = this._modelId

                await this.runLoop({
                    sessionID: sessionId as any,
                    chatId,
                    model: {
                        providerID: providerID as any,
                        modelID: modelID as any,
                    },
                    parts: [
                        {
                            type: "text",
                            text: message,
                        },
                    ],
                    ...(this.options.systemPrompt ? { system: this.options.systemPrompt } : {}),
                    context: this.agentContext,
                })

            } catch (err: any) {
                this.log.create({ service: "code-agent" }).error("Error from SessionPrompt.prompt:", { error: err })
                push({
                    type: "error",
                    error: err?.message ?? String(err),
                })
            } finally {

                done = true
                push({ type: "done" })
                // Cleanup subscriptions
                for (const unsub of unsubs) {
                    unsub()
                }
                // (chatId is persisted in message data, no mutable state to clear)
                // Release the chat mutex
                this._chatPromise = null
                chatResolve()
            }
        })()

        // Yield events as they come in
        try {
            while (!done || events.length > 0) {
                if (events.length > 0) {
                    const event = events.shift()!
                    yield event
                    if (event.type === "done") return
                } else {
                    await new Promise<void>((r) => {
                        resolve = r
                    })
                }
            }
        } finally {
            // Wait for the prompt to finish
            await promptPromise.catch(() => { })
        }
    }

    /**
     * Cancel an ongoing chat in a session.
     * Async — await guarantees the chat has fully stopped.
     * Idempotent — calling abort() when idle is a no-op.
     */
    async abort(): Promise<void> {
        this.assertInitialized()
        // Nothing to abort — return immediately
        if (!this._chatPromise) return

        const sp = this.agentContext.sessionPrompt
        if (sp.abort) {
            sp.abort.abort()
            sp.abort = undefined
            sp.callbacks = []
        }
        if (this.agentContext.sessionStatus.type !== 'idle') {
            this.agentContext.sessionStatus = { type: "idle" }
            this._context.session.emit("session.status", { sessionID: this._currentSessionId, status: { type: "idle" } })
        }
        // Wait for the in-flight chat to fully drain
        await this._chatPromise.catch(() => { })
    }

    /**
     * Register a custom tool at runtime.
     * Tool must follow the Tool.Info format: { id, init }.
     */
    async registerTool(tool: Tool.Info): Promise<void> {
        if (!this.options.tools) {
            this.options.tools = []
        }
        this.options.tools.push(tool)

        // If already initialized, register dynamically
        if (this.initialized) {
            this.agentContext.toolRegistry.register(tool)
        }
    }

    /**
     * Get the current configuration
     */
    get config(): Readonly<CodeAgentOptions> {
        return this.options
    }

    // ── Stats ──────────────────────────────────────────────────────

    /**
     * Get usage stats aggregated from step-finish parts in DB.
     */
    async getUsage() {
        const totals = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        let totalCost = 0
        let totalSteps = 0

        if (this._currentSessionId) {
            const parts = this._dbClient.findMany("part", {
                op: "eq", field: "session_id", value: this._currentSessionId,
            })
            for (const part of parts) {
                if (part.data?.type !== "step-finish") continue
                totalSteps++
                totalCost += part.data.cost ?? 0
                const t = part.data.tokens
                if (t) {
                    totals.input += t.input ?? 0
                    totals.output += t.output ?? 0
                    totals.reasoning += t.reasoning ?? 0
                    totals.cache.read += t.cache?.read ?? 0
                    totals.cache.write += t.cache?.write ?? 0
                }
            }
        }

        return {
            totalSteps,
            totalTokens: totals,
            totalCost,
        }
    }

    /**
     * Get current context window status.
     */
    async getContext() {
        if (!this._currentSessionId) {
            return { contextUsed: 0, contextLimit: 0, compactionThreshold: 0, compactions: 0 }
        }
        return ContextCompaction.getStatus(this.agentContext, this._currentSessionId)
    }

    /**
     * Get messages for the current session (for history restoration and admin display).
     */
    async getSessionMessages(opts?: { limit?: number }) {
        this.assertInitialized()
        if (!this._currentSessionId) return []
        const limit = opts?.limit ?? 50
        const messages: Array<{
            id: string; role: string; createdAt: number
            text?: string; parts?: Array<{ type: string; tool?: string; content?: string }>
        }> = []

        const pageResult = await MessageV2.page(this.agentContext, {
            sessionID: this._currentSessionId as any,
            limit,
        })

        for (const msg of pageResult.items) {
            const simplified: typeof messages[0] = {
                id: msg.info.id,
                role: msg.info.role,
                createdAt: msg.info.time.created,
            }

            if (msg.info.role === "user") {
                const textParts = msg.parts
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text || p.content || "")
                simplified.text = textParts.join("\n")
            } else {
                simplified.parts = msg.parts.map((p: any) => {
                    if (p.type === "text") return { type: "text", content: p.text || p.content || "" }
                    if (p.type === "tool") return { type: "tool", tool: p.tool, content: p.state?.title || p.state?.status }
                    if (p.type === "reasoning") return { type: "thinking", content: p.text || p.content || "" }
                    return { type: p.type }
                })
            }
            messages.push(simplified)
        }
        return messages
    }


    /**
     * Clear session messages.
     * - No args: clear ALL messages for this session
     * - With chatId: clear only messages created during that specific chat() call
     */
    async clearMessages(chatId?: string): Promise<void> {
        this.assertInitialized()

        if (chatId) {
            await this._context.memory.clearMessagesByChatId(chatId)
        } else {
            // Clear all messages for this session
            const sessionId = this._currentSessionId!
            const rows = this._context.db.findMany("message", { op: "eq", field: "session_id", value: sessionId })
            for (const row of rows) {
                this._context.db.remove("message", {
                    op: "and",
                    conditions: [
                        { op: "eq", field: "id", value: row.id },
                        { op: "eq", field: "session_id", value: sessionId },
                    ],
                })
            }
        }
    }

    /**
     * Get current session status (busy/idle/retry).
     */
    getSessionStatus(): string {
        if (!this._currentSessionId) return "idle"
        return this.agentContext.sessionStatus.type
    }

    // ── Core Loop ──────────────────────────────────────────────────

    /**
     * Main agent loop — creates user message, then iterates through reasoning, tool calls, subtasks, and compaction.
     */
    async runLoop(input: SessionPrompt.PromptInput, opts?: { resume?: boolean }): Promise<MessageV2.WithParts> {
        const context = this.agentContext
        const sessionID = input.sessionID

        // ── Prepare: create user message ──
        if (!opts?.resume) {
            const message = await SessionPrompt.createUserMessage(context, input)
            for (const error of message.errors) {
                this._context.session.emit("session.error", { sessionID, error })
            }
            await context.session.touch(sessionID)
        }

        // ── Acquire abort signal ──
        const sp = context.sessionPrompt
        let abort: AbortSignal | undefined
        if (opts?.resume) {
            abort = sp.abort?.signal
        } else {
            if (!sp.abort) {
                const controller = new AbortController()
                sp.abort = controller
                sp.callbacks = []
                abort = controller.signal
            }
        }
        if (!abort) {
            return new Promise<MessageV2.WithParts>((resolve, reject) => {
                sp.callbacks.push({ resolve, reject })
            })
        }

        using _ = defer(() => {
            if (sp.abort) {
                sp.abort.abort()
                sp.abort = undefined
                sp.callbacks = []
            }
            context.sessionStatus = { type: "idle" }
            this._context.session.emit("session.status", { sessionID, status: { type: "idle" } })
        })

        let structuredOutput: unknown | undefined
        let step = 0
        const session = await context.session.get(sessionID)

        while (true) {
            context.sessionStatus = { type: "busy" }
            this._context.session.emit("session.status", { sessionID, status: { type: "busy" } })
            if (abort.aborted) break

            let msgs = await MessageV2.filterCompacted(MessageV2.stream(context, sessionID))

            // ── Compaction check (single point of compaction) ──
            // Two triggers, both checked here before anything else:
            //   1. Token overflow: latest finished assistant's token usage exceeds context limit
            //   2. Message count > 200: fallback when API errors prevent token reporting
            const recentAssistant = msgs.findLast(m => m.info.role === "assistant" && (m.info as MessageV2.Assistant).finish)?.info as MessageV2.Assistant | undefined
            const recentUser = msgs.findLast(m => m.info.role === "user")
            if (recentUser && recentAssistant && !recentAssistant.summary) {
                const userInfo = recentUser.info as MessageV2.User
                const model = await context.provider.getModel(userInfo.model.providerID, userInfo.model.modelID).catch((): null => null)
                const tokenOverflow = model && await ContextCompaction.isOverflowForSession(context, sessionID, model)
                if (tokenOverflow || msgs.length > 200) {
                    const compactResult = await ContextCompaction.process(context, {
                        messages: msgs, parentID: recentUser.info.id, abort, sessionID,
                        auto: true, overflow: !!tokenOverflow, context,
                    })
                    if (compactResult === "stop") break
                    this._context.session.emit("session.compacted", { sessionID })
                    continue
                }
            }

            // Find latest user/assistant messages
            let lastUser: MessageV2.User | undefined
            let lastAssistant: MessageV2.Assistant | undefined
            let lastFinished: MessageV2.Assistant | undefined
            for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i]
                if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
                if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
                if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
                    lastFinished = msg.info as MessageV2.Assistant
                if (lastUser && lastFinished) break
            }
            if (!lastUser) throw new Error("No user message found")

            step++
            if (step === 1) {
                SessionPrompt.ensureTitle({ session, modelID: lastUser.model.modelID, providerID: lastUser.model.providerID, history: msgs, context })
            }

            const model = await context.provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
                if (Provider.ModelNotFoundError.isInstance(e)) {
                    const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
                    this._context.session.emit("session.error", {
                        sessionID,
                        error: new NamedError.Unknown({ message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}` }).toObject(),
                    })
                }
                throw e
            })

            // ── Conversation done? ──
            if (lastAssistant?.finish && !["tool-calls", "unknown"].includes(lastAssistant.finish) && lastUser.id < lastAssistant.id) break

            // ── Reasoning + tool execution ──
            const result = await this.processStep({
                context, session, sessionID, abort, model, lastUser, lastFinished, step, msgs,
                onStructuredOutput: (v: unknown) => { structuredOutput = v },
            })

            if (structuredOutput !== undefined) break
            if (result === "stop") break
        }

        // Finalize
        for await (const item of MessageV2.stream(context, sessionID)) {
            if (item.info.role === "user") continue
            const queued = context.sessionPrompt.callbacks ?? []
            for (const q of queued) q.resolve(item)
            return item
        }
        throw new Error("Impossible")
    }

    /**
     * A single step: resolve tools → call LLM → stream reasoning + tool results.
     */
    private async processStep(input: {
        context: AgentContext
        session: Session.Info
        sessionID: SessionID
        abort: AbortSignal
        model: Provider.Model
        lastUser: MessageV2.User
        lastFinished: MessageV2.Assistant | undefined
        step: number
        msgs: MessageV2.WithParts[]
        onStructuredOutput: (v: unknown) => void
    }): Promise<"stop" | "compact" | "continue"> {
        const { context, session, sessionID, abort, model, lastUser, lastFinished, step } = input

        const msgs = await SessionPrompt.insertReminders({ context, messages: input.msgs, session })

        const processor = LLMRunner.create({
            assistantMessage: (await context.session.updateMessage({
                id: MsgID.ascending(), parentID: lastUser.id, role: "assistant",
                mode: "build", agent: "build", variant: lastUser.variant,
                path: { cwd: context.directory, root: context.worktree },
                modelID: model.id, providerID: model.providerID,
                time: { created: Date.now() }, sessionID,
                ...((lastUser as any).chatId ? { chatId: (lastUser as any).chatId } : {}),
            })) as MessageV2.Assistant,
            sessionID, model, abort, context,
            onStatusChange: (sid, status) => {
                context.sessionStatus = status
                context.session.emit("session.status", { sessionID: sid, status })
            },
            onError: (sid, error) => {
                context.session.emit("session.error", { sessionID: sid, error })
            },
        })


        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

        const tools = await SessionPrompt.resolveTools({
            session, model, tools: lastUser.tools,
            processor, bypassAgentCheck, messages: msgs, agentContext: context,
            onToolEvent: (event, data) => this.emit(event, data),
        })

        if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = SessionPrompt.createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess: input.onStructuredOutput,
            })
        }

        if (step === 1) {

        }

        // Ephemerally wrap queued user messages
        if (step > 1 && lastFinished) {
            for (const msg of msgs) {
                if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
                for (const part of msg.parts) {
                    if (part.type !== "text" || part.ignored || part.synthetic) continue
                    if (!part.text.trim()) continue
                    part.text = [
                        "<system-reminder>",
                        "The user sent the following message:",
                        part.text, "",
                        "Please address this message and continue with your tasks.",
                        "</system-reminder>",
                    ].join("\n")
                }
            }
        }

        // Build system prompt
        const skills = await context.systemPrompt.skills(context)
        const system = [
            ...(await context.systemPrompt.environment(model, context)),
            ...(skills ? [skills] : []),

        ]
        const format = lastUser.format ?? { type: "text" }
        if (format.type === "json_schema") {
            system.push("IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.")
        }

        // LLM streaming + tool execution
        const result = await processor.process({
            user: lastUser, abort, sessionID, system, context,
            messages: MessageV2.toModelMessages(msgs, model),
            tools: tools as any, model,
            toolChoice: format.type === "json_schema" ? "required" : undefined,
        })

        if (input.onStructuredOutput && processor.message.structured !== undefined) {
            processor.message.finish = processor.message.finish ?? "stop"
            await context.session.updateMessage(processor.message)
            return "stop"
        }

        const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)
        if (modelFinished && !processor.message.error && format.type === "json_schema") {
            processor.message.error = new MessageV2.StructuredOutputError({
                message: "Model did not produce structured output", retries: 0,
            }).toObject()
            await context.session.updateMessage(processor.message)
            return "stop"
        }

        return result as any
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private assertInitialized() {
        if (!this.initialized) {
            throw new Error("CodeAgent not initialized. Call agent.init() first.")
        }
    }

    private getProviderEnvKey(providerId: string): string | undefined {
        const map: Record<string, string> = {
            anthropic: "ANTHROPIC_API_KEY",
            openai: "OPENAI_API_KEY",
            google: "GOOGLE_API_KEY",
            groq: "GROQ_API_KEY",
            mistral: "MISTRAL_API_KEY",
            xai: "XAI_API_KEY",
            deepinfra: "DEEPINFRA_API_KEY",
            cerebras: "CEREBRAS_API_KEY",
            cohere: "COHERE_API_KEY",
            perplexity: "PERPLEXITY_API_KEY",
            togetherai: "TOGETHER_API_KEY",
        }
        return map[providerId]
    }

    private getProviderBaseUrlEnv(providerId: string): string | undefined {
        const map: Record<string, string> = {
            anthropic: "ANTHROPIC_BASE_URL",
            openai: "OPENAI_BASE_URL",
            google: "GOOGLE_GENERATIVE_AI_BASE_URL",
        }
        return map[providerId]
    }
}
