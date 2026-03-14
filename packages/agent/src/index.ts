/**
 * CodeAgent - AnyCode's AI Coding Agent
 *
 * A clean wrapper around opencode's core agent-loop.
 * Supports custom prompts, tools, and LLM provider configuration.
 *
 * @example
 * ```ts
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
 * const session = await agent.createSession()
 * const stream = agent.chat(session.id, "Build a React todo app")
 * for await (const event of stream) {
 *   console.log(event)
 * }
 * ```
 */

import type { ToolDefinition } from "@opencode-ai/plugin"
import type z from "zod"

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

export interface CodeAgentOptions {
    /** Working directory for the agent */
    directory: string

    /** LLM provider configuration */
    provider: CodeAgentProvider

    /** Custom system prompt (appended to the default prompt) */
    systemPrompt?: string

    /** Custom tools the agent can use */
    tools?: Record<string, ToolDefinition>

    /** Additional opencode config overrides */
    config?: Record<string, unknown>
}

export interface CodeAgentSession {
    id: string
    title: string
    createdAt: number
}

export type CodeAgentEventType =
    | "text"
    | "text_delta"
    | "tool_call"
    | "tool_result"
    | "error"
    | "done"

export interface CodeAgentEvent {
    type: CodeAgentEventType
    /** For text/text_delta events */
    content?: string
    /** For tool_call events */
    toolName?: string
    toolArgs?: Record<string, unknown>
    /** For tool_result events */
    toolOutput?: string
    /** For error events */
    error?: Error
}

// ── CodeAgent Class ────────────────────────────────────────────────────────

export class CodeAgent {
    private options: CodeAgentOptions

    constructor(options: CodeAgentOptions) {
        this.options = options
    }

    /**
     * Create a new chat session
     */
    async createSession(title?: string): Promise<CodeAgentSession> {
        // TODO: Integrate with opencode Session.create()
        // This requires initializing opencode's Instance, Database, Config, etc.
        throw new Error("Not yet implemented - pending opencode integration")
    }

    /**
     * Send a message to the agent and receive streaming responses
     */
    async *chat(
        sessionId: string,
        message: string,
    ): AsyncGenerator<CodeAgentEvent> {
        // TODO: Integrate with opencode SessionPrompt.chat()
        // The core loop is:
        // 1. SessionPrompt.chat() creates user message
        // 2. SessionProcessor.create() sets up the processing loop
        // 3. LLM.stream() calls the AI model
        // 4. Tool calls are executed via ToolRegistry
        // 5. Loop until done
        throw new Error("Not yet implemented - pending opencode integration")
    }

    /**
     * Abort an ongoing chat in a session
     */
    async abort(sessionId: string): Promise<void> {
        // TODO: Integrate with opencode Session abort mechanism
        throw new Error("Not yet implemented - pending opencode integration")
    }

    /**
     * Register a custom tool at runtime
     */
    registerTool(name: string, tool: ToolDefinition): void {
        if (!this.options.tools) {
            this.options.tools = {}
        }
        this.options.tools[name] = tool
        // TODO: Call ToolRegistry.register() when opencode is initialized
    }

    /**
     * Get the current configuration
     */
    get config(): Readonly<CodeAgentOptions> {
        return this.options
    }
}
