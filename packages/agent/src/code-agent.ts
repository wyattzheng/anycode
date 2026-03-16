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
import type { AgentContext, ShellProvider } from "./context"
import type { Project } from "./project"
import type { VFS } from "./util/vfs"
import type { SearchProvider } from "./util/search"
import type { GitProvider } from "./util/git"
import { EnvService } from "./util/env"
import { EventEmitter } from "events"
import { SchedulerService } from "./util/scheduler"
import { FileTimeService } from "./project"
import { Database } from "./storage"
import { ToolRegistry } from "./tool/registry"
import { Tool } from "./tool/tool"
import { Session } from "./session"
import { SessionPrompt } from "./session/session"


import { MessageV2 } from "./memory/message-v2"
import { MemoryService } from "./memory"

import { Truncate } from "./tool/truncation"



import { SessionStatus } from "./session"


import { Agent } from "./agent"
import { Provider } from "./provider/provider"
import { ModelsDev } from "./provider/models"
import { Skill } from "./skill"

import z from "zod"

import { NamedError } from "./util/error"
import { defer } from "./util/fn"
import { ulid } from "ulid"
import { PartID, MessageID as MsgID, SessionID } from "./session/schema"
import { SystemPrompt } from "./prompt"

import { ContextCompaction } from "./memory/compaction"
import { LLMRunner } from "./llm-runner"
import MAX_STEPS from "./prompt/prompt/max-steps.txt"

// ── Types ──────────────────────────────────────────────────────────────────

export interface CodeAgentProvider {
    /** Provider ID, e.g. "anthropic", "openai", "google" */
    id: string
    /** API key for the provider */
    apiKey: string
    /** Model ID, e.g. "claude-sonnet-4-20250514", "gpt-4o" */
    model: string
    /** Optional base URL override */
    baseUrl?: string
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

    /** Custom tools the agent can use */
    tools?: Record<string, any>

    /**
     * Pre-built configuration object.
     * When provided, bypasses all filesystem-based config loading
     * (opencode.json, .opencode/ directories, etc.).
     * Should conform to opencode's config schema.
     */
    config?: Record<string, unknown>

    /**


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
    private _storageProvider: StorageProvider | undefined
    private _dbClient: any
    private _git: GitProvider
    private _context!: AgentContext

    // ── Phase 0: stateless services (no context dependency) ──────
    readonly env: EnvService
    readonly scheduler: SchedulerService
    readonly fileTime: FileTimeService

    constructor(options: CodeAgentOptions) {
        super()
        this.options = options
        this._git = options.git
        this.setMaxListeners(100)

        // Create stateless services
        this.env = new EnvService()
        this.scheduler = new SchedulerService()
        this.fileTime = new FileTimeService()
    }

    /**
     * Emit a typed event.
     */
    emitEvent(type: string, data: any) {
        this.emit(type, data)
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
     * Can only be called once (from empty → set). Throws if already set.
     */
    setWorkingDirectory(dir: string) {
        const current = this.options.directory
        // Allow setting only if currently unset (empty string)
        if (current && current !== "") {
            throw new Error(`Working directory already set to "${current}". Cannot change once set.`)
        }
        this.options.directory = dir
        this.options.worktree = dir
        if (this._context) {
            ;(this._context as any).directory = dir
            ;(this._context as any).worktree = dir
            ;(this._context as any).project = { ...this._context.project, worktree: dir }
            ;(this._context as any).containsPath = (filepath: string) => {
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

        // Set provider API key via environment variable (opencode convention)
        const envKey = this.getProviderEnvKey(this.options.provider.id)
        if (envKey) {
            this.env.set(envKey, this.options.provider.apiKey)
        }

        // Set base URL if provided
        if (this.options.provider.baseUrl) {
            const baseUrlEnv = this.getProviderBaseUrlEnv(this.options.provider.id)
            if (baseUrlEnv) {
                this.env.set(baseUrlEnv, this.options.provider.baseUrl)
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
            search: this.options.search as any,
            dataPath: this.options.dataPath,
            configOverrides: this.options.config as any,
            instructions: this.options.instructions,
            db: this._dbClient,
            containsPath: (filepath: string) => {
                const normalized = path.resolve(filepath)
                return normalized.startsWith(path.resolve(worktree)) ||
                    normalized.startsWith(path.resolve(this.options.dataPath))
            },
            // Phase 0: stateless services
            env: this.env,
            emitEvent: (type: string, data: any) => this.emitEvent(type, data),
            scheduler: this.scheduler,
            fileTime: this.fileTime,
            memory: undefined as any, // will be set below after ctx is created
        } as AgentContext

        // Create MemoryService (needs ctx reference)
        ctx.memory = new MemoryService(ctx)

        // Forward MemoryService events → CodeAgent EventEmitter
        ctx.memory.on("message.updated", (data: any) => this.emitEvent("message.updated", data))
        ctx.memory.on("message.removed", (data: any) => this.emitEvent("message.removed", data))
        ctx.memory.on("message.part.updated", (data: any) => this.emitEvent("message.part.updated", data))
        ctx.memory.on("message.part.removed", (data: any) => this.emitEvent("message.part.removed", data))
        ctx.memory.on("message.part.delta", (data: any) => this.emitEvent("message.part.delta", data))

        // Phase 1: context-dependent services
        ctx.config = (this.options.config ?? {}) as Record<string, any>
        ctx.sessionStatus = { type: "idle" }

        ctx.sessionPrompt = new SessionPrompt.SessionPromptService()


        ctx.agents = new Agent.AgentService(ctx)
        ctx.modelsDev = new ModelsDev.ModelsDevService(ctx)
        ctx.provider = new Provider.ProviderService(ctx)
        ctx.toolRegistry = new ToolRegistry.ToolRegistryService(ctx)
        ctx.skill = new Skill.SkillService(ctx)





        ctx.provider.bind(ctx)

        this._context = ctx

        // Register custom tools
        if (this.options.tools) {
            for (const [name, def] of Object.entries(this.options.tools)) {
                this._context.toolRegistry.register({
                    id: name,
                    init: async () => ({
                        parameters: z.object(def.args),
                        description: def.description,
                        execute: async (args, toolCtx) => {
                            const result = await def.execute(args as any, toolCtx as any)
                            return {
                                title: "",
                                output: typeof result === "string" ? result : JSON.stringify(result),
                                metadata: {},
                            }
                        },
                    }),
                })
            }
        }

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

        // Create the single session
        const session = await Session.create(this._context)
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
    ): AsyncGenerator<CodeAgentEvent> {
        this.assertInitialized()
        const sessionId = this._currentSessionId!

        // Set up event stream
        const events: CodeAgentEvent[] = []
        let resolve: (() => void) | null = null
        let done = false

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
                        push({
                            type: "error",
                            error: props.error?.message ?? "Unknown error",
                        })
                    }
                }

                const events = ["message.part.delta", "message.part.updated", "session.status", "session.error"] as const
                for (const evt of events) {
                    const handler = (data: any) => globalHandler({ type: evt, properties: data })
                    this.on(evt, handler)
                    unsubs.push(() => this.removeListener(evt, handler))
                }


                const providerID = this.options.provider.id
                const modelID = this.options.provider.model

                await this.runLoop({
                    sessionID: sessionId as any,
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
                console.error("Error from SessionPrompt.prompt:", err)
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
            }
        })()

        // Yield events as they come in
        try {
            while (!done || events.length > 0) {
                if (events.length > 0) {
                    const event = events.shift()!
                    this.recordEvent(event)
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
     * Cancel an ongoing chat in a session
     */
    async abort(): Promise<void> {
        this.assertInitialized()
        const sp = this.agentContext.sessionPrompt
        if (sp.abort) {
            sp.abort.abort()
            sp.abort = undefined
            sp.callbacks = []
        }
        this.agentContext.sessionStatus = { type: "idle" }
        this.emitEvent("session.status", { sessionID: this._currentSessionId, status: { type: "idle" } })
    }

    /**
     * Register a custom tool at runtime
     */
    async registerTool(name: string, tool: any): Promise<void> {
        if (!this.options.tools) {
            this.options.tools = {}
        }
        this.options.tools[name] = tool

        // If already initialized, register dynamically
        if (this.initialized) {
            this.agentContext.toolRegistry.register({
                id: name,
                init: async () => ({
                    parameters: z.object(tool.args),
                    description: tool.description,
                    execute: async (args, ctx) => {
                        const result = await tool.execute(args as any, ctx as any)
                        return {
                            title: "",
                            output: typeof result === "string" ? result : JSON.stringify(result),
                            metadata: {},
                        }
                    },
                }),
            })
        }
    }

    /**
     * Get the current configuration
     */
    get config(): Readonly<CodeAgentOptions> {
        return this.options
    }

    // ── In-memory Stats ────────────────────────────────────────────

    private _stats = {
        startedAt: Date.now(),
        totalMessages: 0,
        totalTokens: { input: 0, output: 0, reasoning: 0 },
        totalCost: 0,
        errors: [] as { time: number; message: string }[],
    }

    /** Record stats from a chat event (called internally) */
    private recordEvent(event: CodeAgentEvent) {
        if (event.type === "message.done" && event.usage) {
            this._stats.totalMessages++
            this._stats.totalTokens.input += event.usage.inputTokens
            this._stats.totalTokens.output += event.usage.outputTokens
            this._stats.totalTokens.reasoning += event.usage.reasoningTokens
            this._stats.totalCost += event.usage.cost
        }
        if (event.type === "error" && event.error) {
            this._stats.errors.push({ time: Date.now(), message: event.error })
            // Keep last 20 errors
            if (this._stats.errors.length > 20) this._stats.errors.shift()
        }
    }

    // ── Debug APIs ─────────────────────────────────────────────────

    /**
     * Get runtime stats (uptime, tokens, cost, errors).
     */
    getStats() {
        const uptimeMs = Date.now() - this._stats.startedAt
        return {
            uptimeMs,
            totalMessages: this._stats.totalMessages,
            totalTokens: { ...this._stats.totalTokens },
            totalCost: this._stats.totalCost,
            errors: [...this._stats.errors],
        }
    }

    /**
     * Get messages for the current session (simplified for admin display).
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
                    if (p.type === "text") return { type: "text", content: (p.content || "").slice(0, 200) }
                    if (p.type === "tool") return { type: "tool", tool: p.tool, content: p.state?.title || p.state?.status }
                    if (p.type === "reasoning") return { type: "thinking", content: (p.content || "").slice(0, 100) }
                    return { type: p.type }
                })
            }
            messages.push(simplified)
        }
        return messages
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
                this.emitEvent("session.error", { sessionID, error })
            }
            await Session.touch(context, sessionID)
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
            this.emitEvent("session.status", { sessionID, status: { type: "idle" } })
        })

        let structuredOutput: unknown | undefined
        let step = 0
        const session = await Session.get(context, sessionID)

        while (true) {
            context.sessionStatus = { type: "busy" }
            this.emitEvent("session.status", { sessionID, status: { type: "busy" } })
            if (abort.aborted) break

            let msgs = await MessageV2.filterCompacted(MessageV2.stream(context, sessionID))

            // Find latest user/assistant messages and pending tasks
            let lastUser: MessageV2.User | undefined
            let lastAssistant: MessageV2.Assistant | undefined
            let lastFinished: MessageV2.Assistant | undefined
            let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
            for (let i = msgs.length - 1; i >= 0; i--) {
                const msg = msgs[i]
                if (!lastUser && msg.info.role === "user") lastUser = msg.info as MessageV2.User
                if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
                if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
                    lastFinished = msg.info as MessageV2.Assistant
                if (lastUser && lastFinished) break
                const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
                if (task && !lastFinished) tasks.push(...task)
            }
            if (!lastUser) throw new Error("No user message found")
            if (lastAssistant?.finish && !["tool-calls", "unknown"].includes(lastAssistant.finish) && lastUser.id < lastAssistant.id) break

            step++
            if (step === 1) {
                SessionPrompt.ensureTitle({ session, modelID: lastUser.model.modelID, providerID: lastUser.model.providerID, history: msgs, context })
            }

            const model = await context.provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
                if (Provider.ModelNotFoundError.isInstance(e)) {
                    const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
                    this.emitEvent("session.error", {
                        sessionID,
                        error: new NamedError.Unknown({ message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}` }).toObject(),
                    })
                }
                throw e
            })
            const task = tasks.pop()


            // ── Compaction ──
            if (task?.type === "compaction") {
                const result = await ContextCompaction.process(context, {
                    messages: msgs, parentID: lastUser.id, abort, sessionID,
                    auto: task.auto, overflow: task.overflow, context,
                })
                if (result === "stop") break
                this.emitEvent("session.compacted", { sessionID })
                continue
            }

            // ── Overflow → auto compact ──
            if (lastFinished && lastFinished.summary !== true && (await ContextCompaction.isOverflow({ tokens: lastFinished.tokens, model, context }))) {
                await ContextCompaction.create(context, { sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
                continue
            }

            // ── Reasoning + tool execution ──
            const result = await this.processStep({
                context, session, sessionID, abort, model, lastUser, lastFinished, step, msgs,
                onStructuredOutput: (v: unknown) => { structuredOutput = v },
            })

            if (structuredOutput !== undefined) break
            if (result === "stop") break
            if (result === "compact") {
                await ContextCompaction.create(context, { sessionID, agent: lastUser.agent, model: lastUser.model, auto: true, overflow: true })
            }
        }

        // Finalize
        ContextCompaction.prune(context, { sessionID })
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
        const agent = await context.agents.get(lastUser.agent)
        const maxSteps = agent.steps ?? Infinity
        const isLastStep = step >= maxSteps

        const msgs = await SessionPrompt.insertReminders({ context, messages: input.msgs, agent, session })

        const processor = LLMRunner.create({
            assistantMessage: (await Session.updateMessage(context, {
                id: MsgID.ascending(), parentID: lastUser.id, role: "assistant",
                mode: agent.name, agent: agent.name, variant: lastUser.variant,
                path: { cwd: context.directory, root: context.worktree },
                cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: model.id, providerID: model.providerID,
                time: { created: Date.now() }, sessionID,
            })) as MessageV2.Assistant,
            sessionID, model, abort, context,
            onStatusChange: (sid, status) => {
                context.sessionStatus = status
                this.emitEvent("session.status", { sessionID: sid, status })
            },
            onError: (sid, error) => {
                this.emitEvent("session.error", { sessionID: sid, error })
            },
        })


        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

        const tools = await SessionPrompt.resolveTools({
            agent, session, model, tools: lastUser.tools,
            processor, bypassAgentCheck, messages: msgs, agentContext: context,
            onToolEvent: (event, data) => this.emitEvent(event, data),
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
        const skills = await SystemPrompt.skills(context, agent)
        const system = [
            ...(await SystemPrompt.environment(model, context)),
            ...(skills ? [skills] : []),

        ]
        const format = lastUser.format ?? { type: "text" }
        if (format.type === "json_schema") {
            system.push("IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.")
        }

        // LLM streaming + tool execution
        const result = await processor.process({
            user: lastUser, agent, abort, sessionID, system, context,
            messages: [
                ...MessageV2.toModelMessages(msgs, model),
                ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : []),
            ],
            tools: tools as any, model,
            toolChoice: format.type === "json_schema" ? "required" : undefined,
        })

        if (input.onStructuredOutput && processor.message.structured !== undefined) {
            processor.message.finish = processor.message.finish ?? "stop"
            await Session.updateMessage(context, processor.message)
            return "stop"
        }

        const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)
        if (modelFinished && !processor.message.error && format.type === "json_schema") {
            processor.message.error = new MessageV2.StructuredOutputError({
                message: "Model did not produce structured output", retries: 0,
            }).toObject()
            await Session.updateMessage(context, processor.message)
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
