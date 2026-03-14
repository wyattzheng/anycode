/**
 * CodeAgent - AnyCode's AI Coding Agent
 *
 * A clean wrapper around opencode's core agent-loop.
 * Supports custom prompts, tools, and LLM provider configuration.
 *
 * @example
 * ```ts
 * import { CodeAgent } from "agent"
 *
 * const agent = new CodeAgent({
 *   directory: "/path/to/project",
 *   provider: { id: "anthropic", apiKey: "sk-...", model: "claude-sonnet-4-20250514" },
 *   systemPrompt: "You are AnyCode's AI assistant...",
 *   tools: {
 *     render_ui: {
 *       description: "Render a UI component",
 *       args: { html: z.string() },
 *       execute: async (args) => `Rendered: ${args.html}`,
 *     },
 *   },
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

import type { ToolDefinition } from "@any-code/opencode/util/plugin"
export type { VirtualFileSystem, VFSStat, VFSDirEntry } from "./vfs"
export { NodeFS } from "./vfs-node"
export { NodeSearchProvider } from "./search-node"
import { NodeSearchProvider } from "./search-node"

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
     *
     * Use NodeFS for standard Node.js filesystem, or provide a custom
     * backend (in-memory, remote, browser, etc.).
     */
    fs: import("./vfs").VirtualFileSystem

    /**
     * Search Provider implementation.
     * Abstracted from VFS to separate file I/O from complex CLI tasks (grep/list).
     */
    search?: import("@any-code/opencode/util/search").SearchProvider

    /**
     * Pre-built instruction texts.
     * When provided, bypasses AGENTS.md / CLAUDE.md file reading.
     * Each string is a complete instruction block.
     */
    instructions?: string[]

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
    project?: import("@any-code/opencode/project/project").Project.Info

    /** Pre-resolved root worktree directory. Defaults to directory. */
    worktree?: string
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

let nextScopeId = 1

export class CodeAgent {
    private options: CodeAgentOptions
    private initialized = false
    private _fs: import("./vfs").VirtualFileSystem | undefined
    private _search: import("@any-code/opencode/util/search").SearchProvider
    /** Unique scope identifier for Instance isolation */
    readonly scopeId: string

    constructor(options: CodeAgentOptions) {
        this.options = options
        this.scopeId = `agent-${nextScopeId++}`
        // Eagerly set custom fs if provided
        if (options.fs) {
            this._fs = options.fs
        }
        this._search = options.search ?? new NodeSearchProvider()
    }

    /**
     * The virtual file system instance.
     */
    get fs(): import("./vfs").VirtualFileSystem {
        return this._fs!
    }

    /**
     * Get the opencode AgentContext representation.
     */
    get agentContext(): import("@any-code/opencode/agent/context").AgentContext {
        const worktree = this.options.worktree ?? this.options.directory
        const project = this.options.project ?? { id: "global", worktree }
        const pathMod = require("path")
        
        return {
            scopeId: this.scopeId,
            directory: this.options.directory,
            worktree,
            project: project as any,
            fs: this._fs as any,
            search: this._search as any,
            paths: this.options.paths as any,
            config: this.options.config as any,
            instructions: this.options.instructions,
            containsPath: (filepath: string) => {
                const normalized = pathMod.resolve(filepath)
                return normalized.startsWith(pathMod.resolve(worktree)) ||
                       normalized.startsWith(pathMod.resolve(this.options.paths.data))
            }
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

        const dbMod = await import("@any-code/opencode/storage/db")
        dbMod.Database.init(this.options.paths.data)
        // Eagerly connect and run migrations during initialization
        dbMod.Database.Client()

        if (this.options.tools) {
            const { ToolRegistry } = await import("@any-code/opencode/tool/registry")
            const { Tool } = await import("@any-code/opencode/tool/tool")
            const z = (await import("zod")).default

            for (const [name, def] of Object.entries(this.options.tools)) {
                ToolRegistry.register({
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

        // Register custom system prompt via plugin hooks
        if (this.options.systemPrompt) {
            const { Plugin } = await import("@any-code/opencode/util/plugin")
            // We'll inject the system prompt via the hook system
            // The prompt will be appended in the chat method
        }

        // Ensure the global project exists in DB to satisfy foreign keys when creating sessions
        const { Database } = await import("@any-code/opencode/storage/db")
        const { ProjectTable } = await import("@any-code/opencode/project/project.sql")
        Database.use((db) => {
            db.insert(ProjectTable).values({
                id: "global" as any,
                worktree: "/",
                vcs: null,
                sandboxes: [],
                time_created: Date.now(),
                time_updated: Date.now()
            }).onConflictDoNothing().run()
        })

        // Initialize plugins (skip if in test/lightweight mode)
        if (!this.options.skipPlugins) {
            const { Plugin } = await import("@any-code/opencode/util/plugin")
            await Plugin.init()
        }

        this.initialized = true
    }

    /**
     * Create a new chat session
     */
    async createSession(title?: string): Promise<CodeAgentSession> {
        this.assertInitialized()

        const instanceMod = await import("@any-code/opencode/project/instance")
        return instanceMod.Instance.provide(this.agentContext, async () => {
            const sessionMod = await import("@any-code/opencode/session/index")
            const session = await sessionMod.Session.create(this.agentContext, {
                title,
            })
            return {
                id: session.id,
                title: session.title,
                createdAt: session.time.created,
            }
        })
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

        // Start the agent loop in the background, providing the Instance context
        const promptPromise = (async () => {
            const instanceMod = await import("@any-code/opencode/project/instance")
            return instanceMod.Instance.provide(this.agentContext, async () => {
                // Subscribe to message part events (inside Instance context)
                const unsubs: (() => void)[] = []

                try {
                    const busMod = await import("@any-code/opencode/bus/index")
                    const Bus = busMod.Bus
                    const msgMod = await import("@any-code/opencode/session/message-v2")
                    const MessageV2 = msgMod.MessageV2
                    const sessionMod = await import("@any-code/opencode/session/index")
                    const Session = sessionMod.Session
                    
                    unsubs.push(
                        Bus.subscribe(MessageV2.Event.PartDelta, (payload: any) => {
                            const props = payload.properties
                            if (props.sessionID !== sessionId) return
                            push({
                                type: "text_delta",
                                content: props.delta,
                            })
                        }),
                    )

                    unsubs.push(
                        Bus.subscribe(MessageV2.Event.PartUpdated, (payload: any) => {
                            const part = payload.properties?.part
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
                        }),
                    )

                    unsubs.push(
                        Bus.subscribe(Session.Event.Error, (payload: any) => {
                            const props = payload.properties
                            if (props.sessionID !== sessionId) return
                            push({
                                type: "error",
                                error: props.error?.message ?? "Unknown error",
                            })
                        }),
                    )

                    // ── Permission handling ────────────────────────────
                    const permMod = await import("@any-code/opencode/permission/next")
                    const PermissionNext = permMod.PermissionNext

                    unsubs.push(
                        Bus.subscribe(PermissionNext.Event.Asked, async (payload: any) => {
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

                            await PermissionNext.reply({
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


                    const { SessionPrompt } = await import("@any-code/opencode/session/prompt")

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
            })
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

        const instanceMod = await import("@any-code/opencode/project/instance")
        return instanceMod.Instance.provide(this.agentContext, async () => {
            const { SessionPrompt } = await import("@any-code/opencode/session/prompt")
            await SessionPrompt.cancel(this.agentContext, sessionId as any)
        })
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
            const { ToolRegistry } = await import("@any-code/opencode/tool/registry")
            const z = (await import("zod")).default

            ToolRegistry.register({
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
