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
import type { ToolDefinition } from "../util/plugin"
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
import { SessionPrompt } from "../session/prompt"
import { Bus } from "../bus"
import { GlobalBus } from "../bus/global"
import { MessageV2 } from "../session/message-v2"
import { PermissionNext } from "../permission/next"
import { Plugin } from "../util/plugin"
import z from "zod"

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
    search?: SearchProvider

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
    private _state = new Map<any, any>()
    private _git: GitProvider

    // ── Service instances ──────────────────────────────────────────
    readonly env: EnvService
    readonly bus: BusService
    readonly scheduler: SchedulerService
    readonly fileTime: FileTimeService

    constructor(options: CodeAgentOptions) {
        this.options = options
        this._git = options.git ?? new NodeGitProvider()

        // Create service instances
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
     */
    get agentContext(): AgentContext {
        const worktree = this.options.worktree ?? this.options.directory

        return {
            directory: this.options.directory,
            worktree,
            project: (this.options.project ?? { id: "global", worktree }) as any,
            fs: this.options.fs as any,
            git: this._git as any,
            search: this.options.search as any,
            paths: this.options.paths as any,
            config: this.options.config as any,
            instructions: this.options.instructions,
            db: this._dbClient,
            state: this._state,
            containsPath: (filepath: string) => {
                const normalized = path.resolve(filepath)
                return normalized.startsWith(path.resolve(worktree)) ||
                       normalized.startsWith(path.resolve(this.options.paths.data))
            },
            // Service instances
            env: this.env,
            bus: this.bus,
            scheduler: this.scheduler,
            fileTime: this.fileTime,
        }
    }

    /**
     * Initialize the agent - must be called before createSession or chat.
     * Boots up opencode subsystems: database, config, plugins, tool registry.
     */
    async init(): Promise<void> {
        if (this.initialized) return

        // Set provider API key via environment variable (opencode convention)
        const envKey = this.getProviderEnvKey(this.options.provider.id)
        if (envKey) {
            process.env[envKey] = this.options.provider.apiKey
        }

        // Set base URL if provided
        if (this.options.provider.baseUrl) {
            const baseUrlEnv = this.getProviderBaseUrlEnv(this.options.provider.id)
            if (baseUrlEnv) {
                process.env[baseUrlEnv] = this.options.provider.baseUrl
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

        if (this.options.tools) {
            for (const [name, def] of Object.entries(this.options.tools)) {
                ToolRegistry.register(this.agentContext, {
                    id: name,
                    init: async () => ({
                        parameters: z.object(def.args),
                        description: def.description,
                        execute: async (args, ctx) => {
                            const result = await def.execute(args as any, ctx as any)
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
            await Plugin.init()
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

                            await PermissionNext.reply(this.agentContext, {
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

                    await SessionPrompt.prompt({
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
            ToolRegistry.register(this.agentContext, {
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
