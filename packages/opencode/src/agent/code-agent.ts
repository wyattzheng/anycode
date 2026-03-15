/**
 * CodeAgent - AnyCode's AI Coding Agent
 *
 * A clean wrapper around opencode's core agent-loop.
 * Supports custom prompts, tools, and LLM provider configuration.
 *
 * @example
 * ```ts
 * import { CodeAgent } from "@any-code/opencode/agent/code-agent"
 *
 * const agent = new CodeAgent({
 *   directory: "/path/to/project",
 *   provider: { id: "anthropic", apiKey: "sk-...", model: "claude-sonnet-4-20250514" },
 *   systemPrompt: "You are AnyCode's AI assistant...",
 * })
 *
 * await agent.init()
 * const session = await agent.createSession()
 * const stream = agent.chat(session.id, "Build a React todo app")
 * for await (const event of stream) {
 *   console.log(event)
 * }
 * ```
 */

import path from "path"
import type { AgentContext } from "./context"
import type { Project } from "../project/project"
import type { VFS } from "../util/vfs"
import type { SearchProvider } from "../util/search"
import { NodeGitProvider, type GitProvider } from "../util/git"
import { EnvService } from "../util/env"
import { BusService } from "../bus"
import { SchedulerService } from "../util/scheduler"
import { FileTimeService } from "../file/time"
import { Database } from "../storage/db"
import { ToolRegistry } from "../tool/registry"
import { Tool } from "../tool/tool"
import { Session } from "../session"
import { SessionPrompt } from "../session/session"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { MessageV2 } from "../session/message-v2"
import { PermissionNext } from "../permission/next"
import { Permission } from "../permission"
import { Truncate } from "../tool/truncation"
import { Snapshot } from "../snapshot"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Config } from "../config/config"
import { Question } from "../session/question"
import { SessionStatus } from "../session"
import { InstructionPrompt } from "../session/instruction"
import { Command } from "./command"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelsDev } from "../provider/models"
import { Skill } from "../skill/skill"
import { Vcs } from "../project/project"
import z from "zod"
import { SessionRevert } from "../session/revert"
import { NamedError } from "../util/error"
import { defer } from "../util/defer"
import { ulid } from "ulid"
import { PartID, MessageID as MsgID, SessionID } from "../session/schema"
import { SystemPrompt } from "../session"
import { SessionSummary } from "../session/summary"
import { SessionCompaction } from "../session/session"
import { LLMRunner } from "./llm-runner"
import MAX_STEPS from "../session/prompt/max-steps.txt"

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
 * A permission request from the agent.
 * When a tool needs permission (e.g., writing files, running commands),
 * the agent emits this to let the App layer decide.
 */
export interface PermissionRequest {
    /** Unique ID for this permission request */
    id: string
    /** Permission type (e.g., "write", "bash", "edit", "external_directory") */
    permission: string
    /** Patterns being requested (e.g., file paths, command patterns) */
    patterns: string[]
    /** Additional metadata about the request */
    metadata: Record<string, unknown>
}

/** Result of a permission request callback */
export type PermissionReply = "allow" | "always" | "deny"

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
    tools?: Record<string, ToolDefinition>

    /**
     * Pre-built configuration object.
     * When provided, bypasses all filesystem-based config loading
     * (opencode.json, .opencode/ directories, etc.).
     * Should conform to opencode's Config.Info schema.
     */
    config?: Record<string, unknown>

    /** Skip plugin initialization (useful for testing when MCP/server deps are not available) */
    skipPlugins?: boolean

    /**
     * Callback for handling permission requests.
     * Called when a tool needs permission that isn't auto-allowed by the ruleset.
     *
     * If not provided, all permissions are auto-allowed.
     *
     * Return:
     * - "allow" — allow this one time
     * - "always" — always allow this permission pattern
     * - "deny" — reject this request
     */
    onPermissionRequest?: (request: PermissionRequest) => Promise<PermissionReply>

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
     * System directory paths for this agent instance.
     * Each CodeAgent instance can have its own data/cache/config directories.
     */
    paths: {
        data: string
        bin: string
        log: string
        cache: string
        config: string
        state: string
        home: string
    }

    /** Override project metadata (discovered from directory if not provided) */
    project?: Project.Info

    /** Pre-resolved root worktree directory. Defaults to directory. */
    worktree?: string

    /**
     * Git command executor.
     * Defaults to NodeGitProvider (shells out to local git binary).
     * Provide a custom implementation for non-Node environments.
     */
    git?: GitProvider
}

export interface CodeAgentSession {
    id: string
    title: string
    createdAt: number
}

export type CodeAgentEventType =
    | "text_delta"
    | "tool_call_start"
    | "tool_call_done"
    | "permission_request"
    | "permission_resolved"
    | "error"
    | "done"

export interface CodeAgentEvent {
    type: CodeAgentEventType
    /** For text_delta events: incremental text */
    content?: string
    /** For tool events */
    toolName?: string
    toolArgs?: Record<string, unknown>
    toolOutput?: string
    /** For error events */
    error?: string
    /** Message metadata (on done events) */
    usage?: {
        inputTokens: number
        outputTokens: number
        cost: number
    }
}

// ── CodeAgent Class ────────────────────────────────────────────────────────

export class CodeAgent {
    private options: CodeAgentOptions
    private initialized = false
    private _storageProvider: StorageProvider | undefined
    private _dbClient: any
    private _git: GitProvider
    private _context!: AgentContext

    // ── Phase 0: stateless services (no context dependency) ──────
    readonly env: EnvService
    readonly bus: BusService
    readonly scheduler: SchedulerService
    readonly fileTime: FileTimeService

    constructor(options: CodeAgentOptions) {
        this.options = options
        this._git = options.git ?? new NodeGitProvider()

        // Create stateless services
        this.env = new EnvService()
        this.bus = new BusService()
        this.scheduler = new SchedulerService()
        this.fileTime = new FileTimeService()
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
     * Initialize the agent - must be called before createSession or chat.
     * Boots up opencode subsystems: database, config, plugins, tool registry,
     * and constructs all service instances.
     */
    async init(): Promise<void> {
        if (this.initialized) return

        // Set provider API key via environment variable (opencode convention)
        const envKey = this.getProviderEnvKey(this.options.provider.id)
        if (envKey) {
            process.env[envKey] = this.options.provider.apiKey
            this.env.set(envKey, this.options.provider.apiKey)
        }

        // Set base URL if provided
        if (this.options.provider.baseUrl) {
            const baseUrlEnv = this.getProviderBaseUrlEnv(this.options.provider.id)
            if (baseUrlEnv) {
                process.env[baseUrlEnv] = this.options.provider.baseUrl
                this.env.set(baseUrlEnv, this.options.provider.baseUrl)
            }
        }

        const migrations = Database.getMigrations()

        if (this.options.storage) {
            this._storageProvider = this.options.storage
            this._dbClient = await this._storageProvider.connect(migrations)
        } else {
            const { BetterSqliteStorage } = await import("./better-sqlite3-storage")
            this._storageProvider = new BetterSqliteStorage(this.options.paths.data)
            this._dbClient = await this._storageProvider!.connect(migrations)
        }

        // ── Build context with all services ──────────────────────────
        const worktree = this.options.worktree ?? this.options.directory
        const ctx = {
            directory: this.options.directory,
            worktree,
            project: (this.options.project ?? { id: "global", worktree }) as any,
            fs: this.options.fs as any,
            git: this._git as any,
            search: this.options.search as any,
            paths: this.options.paths as any,
            configOverrides: this.options.config as any,
            instructions: this.options.instructions,
            db: this._dbClient,
            containsPath: (filepath: string) => {
                const normalized = path.resolve(filepath)
                return normalized.startsWith(path.resolve(worktree)) ||
                    normalized.startsWith(path.resolve(this.options.paths.data))
            },
            // Phase 0: stateless services
            env: this.env,
            bus: this.bus,
            scheduler: this.scheduler,
            fileTime: this.fileTime,
        } as AgentContext

        // Phase 1: context-dependent services
        ctx.config = new Config.ConfigService(ctx)
        ctx.question = new Question.QuestionService()
        ctx.sessionStatus = new SessionStatus.SessionStatusService(ctx)
        ctx.instruction = new InstructionPrompt.InstructionService()
        ctx.sessionPrompt = new SessionPrompt.SessionPromptService()
        ctx.permission = new Permission.PermissionService()
        ctx.permissionNext = new PermissionNext.PermissionNextService(ctx)
        ctx.command = new Command.CommandService(ctx)
        ctx.agents = new Agent.AgentService(ctx)
        ctx.provider = new Provider.ProviderService(ctx)
        ctx.modelsDev = new ModelsDev.ModelsDevService(ctx)
        ctx.toolRegistry = new ToolRegistry.ToolRegistryService(ctx)
        ctx.skill = new Skill.SkillService(ctx)
        ctx.fileWatcher = new FileWatcher.FileWatcherService(ctx)
        ctx.file = new File.FileService(ctx)
        ctx.vcs = new Vcs.VcsService()

        // Bind context to services that need it for instance methods
        ctx.instruction.bind(ctx)
        ctx.permissionNext.bind(ctx)
        ctx.provider.bind(ctx)
        ctx.question.bind(ctx)

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

        // Initialize plugins (skip if in test/lightweight mode)
        if (!this.options.skipPlugins) {
        }

        this.initialized = true
    }

    /**
     * Create a new chat session
     */
    async createSession(title?: string): Promise<CodeAgentSession> {
        this.assertInitialized()

        const session = await Session.create(this.agentContext, { title })
        return {
            id: session.id,
            title: session.title,
            createdAt: session.time.created,
        }
    }

    /**
     * Send a message to the agent and receive streaming responses.
     * Subscribe to Bus events for real-time updates.
     */
    async *chat(
        sessionId: string,
        message: string,
    ): AsyncGenerator<CodeAgentEvent> {
        this.assertInitialized()

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
                // Use GlobalBus to receive ALL events (scoped Bus.subscribe
                // misses events published with undefined context)
                const globalHandler = (evt: { directory?: string; payload: any }) => {
                    const payload = evt.payload
                    if (!payload) return
                    const type = payload.type
                    const props = payload.properties

                    if (type === MessageV2.Event.PartDelta.type) {
                        if (props?.sessionID !== sessionId) return
                        push({
                            type: "text_delta",
                            content: props.delta,
                        })
                    }

                    if (type === MessageV2.Event.PartUpdated.type) {
                        const part = props?.part
                        if (!part || part.sessionID !== sessionId) return
                        if (part.type === "tool" && part.state.status === "running") {
                            push({
                                type: "tool_call_start",
                                toolName: part.tool,
                                toolArgs: part.state.input as Record<string, unknown>,
                            })
                        }
                        if (part.type === "tool" && part.state.status === "completed") {
                            push({
                                type: "tool_call_done",
                                toolName: part.tool,
                                toolOutput: part.state.output,
                            })
                        }
                        if (part.type === "tool" && part.state.status === "error") {
                            push({
                                type: "error",
                                error: part.state.error,
                            })
                        }
                    }

                    if (type === Session.Event.Error.type) {
                        if (props?.sessionID !== sessionId) return
                        push({
                            type: "error",
                            error: props.error?.message ?? "Unknown error",
                        })
                    }
                }
                GlobalBus.on("event", globalHandler)
                unsubs.push(() => GlobalBus.off("event", globalHandler))

                // ── Permission handling ────────────────────────────
                unsubs.push(
                    Bus.subscribe(this.agentContext, PermissionNext.Event.Asked, async (payload: any) => {
                        const request = payload.properties
                        if (request.sessionID !== sessionId) return

                        const permRequest: PermissionRequest = {
                            id: request.id,
                            permission: request.permission,
                            patterns: request.patterns ?? [],
                            metadata: request.metadata ?? {},
                        }

                        push({
                            type: "permission_request" as CodeAgentEventType,
                            toolName: request.permission,
                            toolArgs: request.metadata,
                        })

                        let reply: PermissionReply = "allow"
                        if (this.options.onPermissionRequest) {
                            try {
                                reply = await this.options.onPermissionRequest(permRequest)
                            } catch {
                                reply = "deny"
                            }
                        }

                        const replyMap: Record<PermissionReply, "once" | "always" | "reject"> = {
                            allow: "once",
                            always: "always",
                            deny: "reject",
                        }

                        await this.agentContext.permissionNext.reply({
                            requestID: request.id,
                            reply: replyMap[reply],
                        })

                        push({
                            type: "permission_resolved" as CodeAgentEventType,
                            toolName: request.permission,
                            content: reply,
                        })
                    }),
                )

                const providerID = this.options.provider.id
                const modelID = this.options.provider.model

                await this.prepare({
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

                await this.runLoop(sessionId as any)

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
    async abort(sessionId: string): Promise<void> {
        this.assertInitialized()
        await SessionPrompt.cancel(this.agentContext, sessionId as any)
    }

    /**
     * Register a custom tool at runtime
     */
    async registerTool(name: string, tool: ToolDefinition): Promise<void> {
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


    // ── Core Loop ──────────────────────────────────────────────────

    /**
     * Prepare a prompt — create user message, set permissions.
     * Call runLoop() after this to start the agent loop.
     */
    async prepare(input: SessionPrompt.PromptInput): Promise<MessageV2.WithParts | void> {
        const context = this.agentContext
        const session = await Session.get(context, input.sessionID)
        await SessionRevert.cleanup(context, session)

        const message = await SessionPrompt.createUserMessage(context, input)
        await Session.touch(context, input.sessionID)

        const permissions: PermissionNext.Ruleset = []
        for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
            permissions.push({ permission: tool, action: enabled ? "allow" : "deny", pattern: "*" })
        }
        if (permissions.length > 0) {
            session.permission = permissions
            await Session.setPermission(context, { sessionID: session.id, permission: permissions })
        }
        return message
    }

    /**
     * Main agent loop — iterates through reasoning, tool calls, subtasks, and compaction.
     */
    async runLoop(sessionID: SessionID, opts?: { resume?: boolean }): Promise<MessageV2.WithParts> {
        const context = this.agentContext
        const abort = opts?.resume
            ? SessionPrompt.resume(context, sessionID)
            : SessionPrompt.start(context, sessionID)
        if (!abort) {
            return new Promise<MessageV2.WithParts>((resolve, reject) => {
                context.sessionPrompt.sessions[sessionID].callbacks.push({ resolve, reject })
            })
        }

        using _ = defer(() => SessionPrompt.cancel(context, sessionID))

        let structuredOutput: unknown | undefined
        let step = 0
        const session = await Session.get(context, sessionID)

        while (true) {
            context.sessionStatus.set(sessionID, { type: "busy" })
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
                    Bus.publish(context, Session.Event.Error, {
                        sessionID,
                        error: new NamedError.Unknown({ message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}` }).toObject(),
                    })
                }
                throw e
            })
            const task = tasks.pop()


            // ── Compaction ──
            if (task?.type === "compaction") {
                const result = await SessionCompaction.process(context, {
                    messages: msgs, parentID: lastUser.id, abort, sessionID,
                    auto: task.auto, overflow: task.overflow, context,
                })
                if (result === "stop") break
                continue
            }

            // ── Overflow → auto compact ──
            if (lastFinished && lastFinished.summary !== true && (await SessionCompaction.isOverflow({ tokens: lastFinished.tokens, model, context }))) {
                await SessionCompaction.create(context, { sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
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
                await SessionCompaction.create(context, { sessionID, agent: lastUser.agent, model: lastUser.model, auto: true, overflow: true })
            }
        }

        // Finalize
        SessionCompaction.prune(context, { sessionID })
        for await (const item of MessageV2.stream(context, sessionID)) {
            if (item.info.role === "user") continue
            const queued = context.sessionPrompt.sessions[sessionID]?.callbacks ?? []
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
        })
        using _ = defer(() => context.instruction.clear(processor.message.id))

        const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
        const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

        const tools = await SessionPrompt.resolveTools({
            agent, session, model, tools: lastUser.tools,
            processor, bypassAgentCheck, messages: msgs, agentContext: context,
        })

        if (lastUser.format?.type === "json_schema") {
            tools["StructuredOutput"] = SessionPrompt.createStructuredOutputTool({
                schema: lastUser.format.schema,
                onSuccess: input.onStructuredOutput,
            })
        }

        if (step === 1) {
            SessionSummary.summarize(context, { sessionID, messageID: lastUser.id })
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
            ...(await context.instruction.system()),
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
            tools, model,
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
