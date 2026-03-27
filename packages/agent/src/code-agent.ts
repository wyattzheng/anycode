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
import { ToolRegistryService } from "./tool/registry"
import { Tool } from "./tool/tool"
import { Session, SessionService } from "./session"
import { SessionPrompt, SessionPromptService } from "./session/session"
import { MessageV2 } from "./memory/message-v2"
import { MemoryService } from "./memory"
import type { Settings } from "./settings"
import { Provider, VendorRegistry, createLLMStream, toModelMessages } from "@any-code/provider"
import { Auth } from "./util/auth"
import type { LLMToolDef, LLMMessage } from "@any-code/utils"

import type { Logger } from "@any-code/utils"
import { NamedError } from "./util/error"
import { defer } from "./util/fn"
import { ulid } from "ulid"
import { MessageID as MsgID, PartID, SessionID } from "./session/schema"
import { SystemPrompt } from "./prompt"
import { CompactionService } from "./memory/compaction"
import { SessionStatus } from "./session"

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

        ctx.sessionPrompt = new SessionPromptService()
        ctx.systemPrompt = new SystemPrompt()
        ctx.compaction = new CompactionService()



        ctx.provider = new Provider.ProviderService(ctx, this.options.provider)
        ctx.toolRegistry = new ToolRegistryService(ctx)


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
            try {
                // ── Create user message ──
                const sessionID = sessionId as SessionID
                const context = this.agentContext

                const userInput: SessionPrompt.PromptInput = {
                    sessionID,
                    chatId,
                    model: {
                        providerID: this._providerId as any,
                        modelID: this._modelId as any,
                    },
                    parts: [{ type: "text", text: message }],
                    ...(this.options.systemPrompt ? { system: this.options.systemPrompt } : {}),
                    context,
                }

                const userMsg = await SessionPrompt.createUserMessage(context, userInput)
                for (const error of userMsg.errors) {
                    const errorMsg = (error as any)?.data?.message || "Unknown error"
                    push({ type: "error", error: errorMsg })
                }
                await context.session.touch(sessionID)

                // ── Acquire abort signal ──
                const sp = context.sessionPrompt
                const controller = new AbortController()
                sp.abort = controller
                sp.callbacks = []
                const abort = controller.signal

                try {
                    let structuredOutput: unknown | undefined
                    let step = 0
                    const session = await context.session.get(sessionID)

                    while (true) {
                        context.sessionStatus = { type: "busy" }
                        push({ type: "session.status", status: "busy" })
                        if (abort.aborted) break

                        let msgs = await MessageV2.filterCompacted(MessageV2.stream(context, sessionID))

                        // ── Compaction check ──
                        const recentAssistant = msgs.findLast(m => m.info.role === "assistant" && (m.info as MessageV2.Assistant).finish)?.info as MessageV2.Assistant | undefined
                        const recentUser = msgs.findLast(m => m.info.role === "user")
                        if (recentUser && recentAssistant && !recentAssistant.summary) {
                            const userInfo = recentUser.info as MessageV2.User
                            const compModel = await context.provider.getModel(userInfo.model.providerID, userInfo.model.modelID).catch((): null => null)
                            const tokenOverflow = compModel && await context.compaction.isOverflowForSession(context, sessionID, compModel)
                            if (tokenOverflow || msgs.length > 200) {
                                const compactResult = await context.compaction.process(context, {
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

                        // ── Prepare: create assistant message, resolve tools ──
                        const msgsWithReminders = await SessionPrompt.insertReminders({ context, messages: msgs, session })

                        const stepResult = await this.invokeToolStep({
                            context, sessionID, session, abort, model, step,
                            msgs, msgsWithReminders, lastUser, lastFinished,
                            push,
                        })

                        if (stepResult.structuredOutput !== undefined) structuredOutput = stepResult.structuredOutput
                        if (stepResult.action === "break") break
                    }
                } finally {
                    // Cleanup abort
                    if (sp.abort) {
                        sp.abort.abort()
                        sp.abort = undefined
                        sp.callbacks = []
                    }
                    context.sessionStatus = { type: "idle" }
                    push({ type: "session.status", status: "idle" })
                }

            } catch (err: any) {
                this.log.create({ service: "code-agent" }).error("Error from SessionPrompt.prompt:", { error: err })
                push({
                    type: "error",
                    error: err?.message ?? String(err),
                })
            } finally {
                done = true
                push({ type: "done" })
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
        return this.agentContext.compaction.getStatus(this.agentContext, this._currentSessionId)
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


    // ── Private helpers ────────────────────────────────────────────────────

    /**
     * Execute a single LLM invocation step: create assistant message, stream response,
     * handle tool calls/results, and decide whether to continue or stop.
     */
    private async invokeToolStep(input: {
        context: AgentContext
        sessionID: string
        session: any
        abort: AbortSignal
        model: Provider.Model
        step: number
        msgs: MessageV2.WithParts[]
        msgsWithReminders: MessageV2.WithParts[]
        lastUser: MessageV2.User
        lastFinished?: MessageV2.Assistant
        push: (event: any) => void
    }): Promise<{ action: "continue" | "break"; structuredOutput?: unknown }> {
        const { context, sessionID, session, abort, model, step, msgs, msgsWithReminders, lastUser, lastFinished, push } = input

        const assistantMessage = (await context.memory.updateMessage({
            id: MsgID.ascending(), parentID: lastUser.id, role: "assistant",
            mode: "build", agent: "build", variant: lastUser.variant,
            path: { cwd: context.directory, root: context.worktree },
            modelID: model.id, providerID: model.providerID,
            time: { created: Date.now() }, sessionID,
            ...((lastUser as any).chatId ? { chatId: (lastUser as any).chatId } : {}),
        })) as MessageV2.Assistant

        const toolcalls: Record<string, MessageV2.ToolPart> = {}
        let structuredOutput: unknown | undefined

        const lastUserMsg = msgsWithReminders.findLast((m) => m.info.role === "user")
        const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

        const tools = await SessionPrompt.resolveTools({
            session, model, tools: lastUser.tools,
            processor: {
                message: assistantMessage,
                partFromToolCall: (id: string) => toolcalls[id],
            } as any,
            bypassAgentCheck, messages: msgsWithReminders, agentContext: context,
            onToolEvent: (event, data) => this.emit(event, data),
        })

        if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = SessionPrompt.createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess: (v: unknown) => { structuredOutput = v },
            })
        }

        // Ephemerally wrap queued user messages
        if (step > 1 && lastFinished) {
            for (const msg of msgsWithReminders) {
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
        const systemPrompts = [
            ...(await context.systemPrompt.environment(model, context)),
        ]
        const format = lastUser.format ?? { type: "text" }
        if (format.type === "json_schema") {
            systemPrompts.push("IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.")
        }

        const modelProvider = VendorRegistry.getModelProvider({ model })
        const includeProviderPrompt = modelProvider.shouldIncludeProviderSystemPrompt()

        const system: string[] = [
            [
                ...(includeProviderPrompt ? context.systemPrompt.provider(model) : []),
                ...systemPrompts,
                ...(lastUser.system ? [lastUser.system] : []),
            ]
                .filter((x) => x)
                .join("\n"),
        ]

        // Filter tools by user permissions
        const filteredTools = { ...tools } as Record<string, LLMToolDef>
        for (const name of Object.keys(filteredTools)) {
            if (lastUser.tools?.[name] === false) {
                delete filteredTools[name]
            }
        }

        const modelMessages = toModelMessages(msgsWithReminders, model, {
            isAbortedError: (e: any) => e?.type === "MessageAbortedError",
            generateId: () => MsgID.ascending(),
        })

        // ── Stream from provider ──
        const l = context.log.create({ service: "llm" })
            .clone()
            .tag("providerID", model.providerID)
            .tag("modelID", model.id)
            .tag("sessionID", sessionID)

        let needsCompaction = false

        try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}

            const stream = await createLLMStream(
                {
                    provider: context.provider,
                    auth: { get: Auth.get },
                    config: context.config,
                    systemPrompt: context.systemPrompt,
                    log: { info: l.info.bind(l), error: l.error.bind(l) },
                },
                {
                    model,
                    sessionID,
                    system,
                    messages: modelMessages,
                    tools: filteredTools,
                    toolChoice: format.type === "json_schema" ? "required" : undefined,
                    abort,
                    retries: undefined,
                },
            )

            // ── Process stream chunks ──
            for await (const value of stream.fullStream) {
                abort.throwIfAborted()
                switch (value.type) {
                    case "start":
                        context.sessionStatus = { type: "busy" }
                        push({ type: "session.status", status: "busy" })
                        break

                    case "reasoning-start":
                        if (value.id in reasoningMap) continue
                        const reasoningPart = {
                            id: PartID.ascending(),
                            messageID: assistantMessage.id,
                            sessionID: assistantMessage.sessionID,
                            type: "reasoning" as const,
                            text: "",
                            time: { start: Date.now() },
                            metadata: value.providerMetadata,
                        }
                        reasoningMap[value.id] = reasoningPart
                        await context.memory.updatePart(reasoningPart)
                        push({ type: "thinking.start" })
                        break

                    case "reasoning-delta":
                        if (value.id in reasoningMap) {
                            const part = reasoningMap[value.id]
                            part.text += value.text
                            if (value.providerMetadata) part.metadata = value.providerMetadata
                            await context.memory.updatePartDelta({
                                sessionID: part.sessionID,
                                messageID: part.messageID,
                                partID: part.id,
                                field: "text",
                                delta: value.text,
                            })
                            push({ type: "thinking.delta", thinkingContent: value.text })
                        }
                        break

                    case "reasoning-end":
                        if (value.id in reasoningMap) {
                            const part = reasoningMap[value.id]
                            part.text = part.text.trimEnd()
                            part.time = { ...part.time, end: Date.now() }
                            if (value.providerMetadata) part.metadata = value.providerMetadata
                            await context.memory.updatePart(part)
                            push({ type: "thinking.end", thinkingDuration: part.time.end - part.time.start })
                            delete reasoningMap[value.id]
                        }
                        break

                    case "tool-input-start":
                        const toolPart = await context.memory.updatePart({
                            id: toolcalls[value.id]?.id ?? PartID.ascending(),
                            messageID: assistantMessage.id,
                            sessionID: assistantMessage.sessionID,
                            type: "tool",
                            tool: value.toolName,
                            callID: value.id,
                            state: { status: "pending", input: {}, raw: "" },
                        })
                        toolcalls[value.id] = toolPart as MessageV2.ToolPart
                        break

                    case "tool-input-delta":
                    case "tool-input-end":
                        break

                    case "tool-call": {
                        const match = toolcalls[value.toolCallId]
                        if (match) {
                            const part = await context.memory.updatePart({
                                ...match,
                                tool: value.toolName,
                                state: {
                                    status: "running",
                                    input: value.input,
                                    time: { start: Date.now() },
                                },
                                metadata: value.providerMetadata,
                            })
                            toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                            push({
                                type: "tool.start",
                                toolCallId: value.toolCallId,
                                toolName: value.toolName,
                                toolArgs: value.input as Record<string, unknown>,
                            })

                            // Doom loop detection
                            const parts = await MessageV2.parts(context, assistantMessage.id)
                            const lastN = (parts as any[]).slice(-DOOM_LOOP_THRESHOLD)
                            if (
                                lastN.length === DOOM_LOOP_THRESHOLD &&
                                lastN.every(
                                    (p) =>
                                        p.type === "tool" &&
                                        p.tool === value.toolName &&
                                        p.state.status !== "pending" &&
                                        JSON.stringify(p.state.input) === JSON.stringify(value.input),
                                )
                            ) {
                                // Doom loop detected
                            }
                        }
                        break
                    }

                    case "tool-result": {
                        const match = toolcalls[value.toolCallId]
                        if (match && match.state.status === "running") {
                            const endTime = Date.now()
                            await context.memory.updatePart({
                                ...match,
                                state: {
                                    status: "completed",
                                    input: value.input ?? match.state.input,
                                    output: context.compaction.truncateToolOutput((value.output as any).output),
                                    metadata: (value.output as any).metadata,
                                    title: (value.output as any).title,
                                    time: { start: match.state.time.start, end: endTime },
                                    attachments: (value.output as any).attachments,
                                },
                            })
                            push({
                                type: "tool.done",
                                toolCallId: value.toolCallId,
                                toolName: match.tool,
                                toolOutput: (value.output as any).output,
                                toolTitle: (value.output as any).title,
                                toolMetadata: (value.output as any).metadata,
                                toolDuration: endTime - match.state.time.start,
                            })
                            delete toolcalls[value.toolCallId]
                        }
                        break
                    }

                    case "tool-error": {
                        const match = toolcalls[value.toolCallId]
                        if (match && match.state.status === "running") {
                            const endTime = Date.now()
                            await context.memory.updatePart({
                                ...match,
                                state: {
                                    status: "error",
                                    input: value.input ?? match.state.input,
                                    error: (value.error as any).toString(),
                                    time: { start: match.state.time.start, end: endTime },
                                },
                            })
                            push({
                                type: "tool.error",
                                toolCallId: value.toolCallId,
                                toolName: match.tool,
                                error: (value.error as any).toString(),
                                toolDuration: endTime - match.state.time.start,
                            })
                            delete toolcalls[value.toolCallId]
                        }
                        break
                    }

                    case "error":
                        throw value.error

                    case "start-step":
                        await context.memory.updatePart({
                            id: PartID.ascending(),
                            messageID: assistantMessage.id,
                            sessionID,
                            type: "step-start",
                        })
                        break

                    case "finish-step":
                        const usage = SessionService.getUsage({
                            model,
                            usage: value.usage as any,
                            metadata: value.providerMetadata,
                        })
                        assistantMessage.finish = value.finishReason
                        await context.memory.updatePart({
                            id: PartID.ascending(),
                            reason: value.finishReason,
                            messageID: assistantMessage.id,
                            sessionID: assistantMessage.sessionID,
                            type: "step-finish",
                            tokens: usage.tokens,
                            cost: usage.cost,
                        })
                        await context.memory.updateMessage(assistantMessage)
                        push({
                            type: "message.done",
                            usage: {
                                inputTokens: usage.tokens.input,
                                outputTokens: usage.tokens.output,
                                reasoningTokens: usage.tokens.reasoning,
                                cost: usage.cost,
                            },
                        })

                        if (
                            !assistantMessage.summary &&
                            (await context.compaction.isOverflow({ tokens: usage.tokens, model, context }))
                        ) {
                            needsCompaction = true
                        }
                        break

                    case "text-start":
                        currentText = {
                            id: PartID.ascending(),
                            messageID: assistantMessage.id,
                            sessionID: assistantMessage.sessionID,
                            type: "text",
                            text: "",
                            time: { start: Date.now() },
                            metadata: value.providerMetadata,
                        }
                        await context.memory.updatePart(currentText)
                        break

                    case "text-delta":
                        if (currentText) {
                            currentText.text += value.text
                            if (value.providerMetadata) currentText.metadata = value.providerMetadata
                            await context.memory.updatePartDelta({
                                sessionID: currentText.sessionID,
                                messageID: currentText.messageID,
                                partID: currentText.id,
                                field: "text",
                                delta: value.text,
                            })
                            push({ type: "text.delta", content: value.text })
                        }
                        break

                    case "text-end":
                        if (currentText) {
                            currentText.text = currentText.text.trimEnd()
                            currentText.time = { start: Date.now(), end: Date.now() }
                            if (value.providerMetadata) currentText.metadata = value.providerMetadata
                            await context.memory.updatePart(currentText)
                        }
                        currentText = undefined
                        break

                    case "finish":
                        break

                    default:
                        context.log.create({ service: "session.processor" }).info("unhandled stream chunk", {
                            type: (value as any).type,
                        })
                        continue
                }
                if (needsCompaction) break
            }
        } catch (e: any) {
            context.log.create({ service: "session.processor" }).error("process", {
                error: e,
                stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
                needsCompaction = true
                const errorMsg = (error as any)?.data?.message || "Context overflow"
                push({ type: "error", error: errorMsg })
            } else {
                assistantMessage.error = error
                const errorMsg = (error as any)?.data?.message || "Unknown error"
                push({ type: "error", error: errorMsg })
            }
        }

        // Abort any pending tool calls
        const pendingParts = await MessageV2.parts(context, assistantMessage.id)
        for (const part of pendingParts) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
                await context.memory.updatePart({
                    ...part,
                    state: {
                        ...part.state,
                        status: "error",
                        error: "Tool execution aborted",
                        time: { start: Date.now(), end: Date.now() },
                    },
                })
            }
        }
        assistantMessage.time.completed = Date.now()
        await context.memory.updateMessage(assistantMessage)

        context.sessionStatus = { type: "idle" }
        push({ type: "session.status", status: "idle" })

        // ── Decide next action ──
        if (needsCompaction) return { action: "continue" }
        if (structuredOutput !== undefined) return { action: "break", structuredOutput }
        if (assistantMessage.error) return { action: "break" }

        const modelFinished = assistantMessage.finish && !["tool-calls", "unknown"].includes(assistantMessage.finish)
        if (modelFinished && format.type === "json_schema") {
            assistantMessage.error = new MessageV2.StructuredOutputError({
                message: "Model did not produce structured output", retries: 0,
            }).toObject()
            await context.memory.updateMessage(assistantMessage)
            return { action: "break" }
        }
        if (modelFinished) return { action: "break" }

        return { action: "continue" }
    }


    private assertInitialized() {
        if (!this.initialized) {
            throw new Error("CodeAgent not initialized. Call agent.init() first.")
        }
    }


}

// ── Utilities ────────────────────────────────────────────────────────────────

const DOOM_LOOP_THRESHOLD = 3

