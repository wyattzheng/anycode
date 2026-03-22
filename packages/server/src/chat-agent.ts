/**
 * IChatAgent — Unified chat agent interface for AnyCode.
 *
 * Abstracts over different agent backends (AnyCode native, Claude Code SDK, etc.)
 * so that the server's WebSocket chat handler only consumes a single interface.
 *
 * Controlled by the AGENT environment variable:
 *   AGENT=anycode     → AnyCodeAgent (default, wraps CodeAgent from @any-code/agent)
 *   AGENT=claudecode  → ClaudeCodeAgent (wraps @anthropic-ai/claude-agent-sdk)
 */

import { CodeAgent, type CodeAgentEvent, type CodeAgentOptions, type TerminalProvider, type PreviewProvider } from "@any-code/agent"

// Re-export the event type under a unified name
export type ChatAgentEvent = CodeAgentEvent

/**
 * Unified configuration for all ChatAgent backends.
 * Each backend picks the fields it needs.
 */
export interface ChatAgentConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** AnyCode-specific: full CodeAgentOptions for internal CodeAgent creation */
  codeAgentOptions?: CodeAgentOptions
  /** Terminal provider for the session (used by ClaudeCodeAgent MCP tools) */
  terminal?: TerminalProvider
  /** Preview provider for the session (used by ClaudeCodeAgent MCP tools) */
  preview?: PreviewProvider
}

/**
 * Unified chat agent interface.
 * All agent backends must implement this interface.
 * The server calls these methods uniformly — no instanceof checks needed.
 */
export interface IChatAgent {
  /** Human-readable name of this agent backend */
  readonly name: string

  /** Unique session identifier */
  readonly sessionId: string

  /** Send a message and receive streaming events */
  chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown>

  /** Abort current chat/task */
  abort(): void

  /** Ensure agent is ready (lazy init, idempotent) */
  ensureInit(): Promise<void>

  /** Listen for agent events (directory.set, session.updated, etc.) */
  on(event: string, handler: (data: any) => void): void

  /** Set the working directory for this session */
  setWorkingDirectory(dir: string): void

  /** Get agent stats */
  getStats(): any

  /** Get session message history */
  getSessionMessages(opts: { limit: number }): Promise<any>
}

// ── AnyCodeAgent ─────────────────────────────────────────────────────────

/**
 * AnyCodeAgent — internally creates and owns a CodeAgent instance.
 * Delegates all IChatAgent methods to the underlying CodeAgent.
 */
export class AnyCodeAgent implements IChatAgent {
  readonly name = "AnyCode Agent"
  private config: ChatAgentConfig
  private _codeAgent: InstanceType<typeof CodeAgent>
  private _initialized = false

  constructor(config: ChatAgentConfig) {
    this.config = config
    if (!config.codeAgentOptions) {
      throw new Error("AnyCodeAgent requires codeAgentOptions in ChatAgentConfig")
    }
    this._codeAgent = new CodeAgent(config.codeAgentOptions)
  }

  async ensureInit(): Promise<void> {
    if (!this._initialized) {
      await this._codeAgent.init()
      this._initialized = true
    }
  }

  get sessionId(): string {
    return this._codeAgent.sessionId
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    await this.ensureInit()
    yield* this._codeAgent.chat(input)
  }

  abort(): void {
    this._codeAgent.abort()
  }

  on(event: string, handler: (data: any) => void): void {
    this._codeAgent.on(event, handler)
  }

  setWorkingDirectory(dir: string): void {
    this._codeAgent.setWorkingDirectory(dir)
  }

  getStats(): any {
    return this._codeAgent.getStats()
  }

  getSessionMessages(opts: { limit: number }): Promise<any> {
    return this._codeAgent.getSessionMessages(opts)
  }
}

// ── ClaudeCodeAgent ──────────────────────────────────────────────────────

/**
 * ClaudeCodeAgent — wraps @anthropic-ai/claude-agent-sdk.
 *
 * Uses dynamic import to avoid hard dependency on the SDK package.
 * Maps Claude SDK events to standard ChatAgentEvent (CodeAgentEvent) format.
 * Session-level methods (on, setWorkingDirectory, etc.) are no-ops.
 */
export class ClaudeCodeAgent implements IChatAgent {
  readonly name = "Claude Code Agent"
  readonly sessionId: string
  private abortController: AbortController | null = null
  private config: ChatAgentConfig
  private eventHandlers = new Map<string, Array<(data: any) => void>>()
  /** SDK-managed session ID — populated after first response, used for `resume` on subsequent calls */
  private _claudeSessionId: string | null = null

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.sessionId = `claude-${Date.now()}`
  }

  async ensureInit(): Promise<void> {
    // No async setup needed for Claude Code Agent
  }

  on(event: string, handler: (data: any) => void): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  setWorkingDirectory(_dir: string): void {
    // Claude Code manages its own working directory
  }

  getStats(): any {
    return null
  }

  getSessionMessages(_opts: { limit: number }): Promise<any> {
    return Promise.resolve([])
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    // Dynamic import — only loads if the SDK is actually installed
    let queryFn: any
    try {
      // @ts-ignore — optional dependency, may not be installed
      const sdk = await import("@anthropic-ai/claude-agent-sdk")
      queryFn = sdk.query
    } catch {
      yield {
        type: "error",
        error: "Claude Code SDK (@anthropic-ai/claude-agent-sdk) is not installed. " +
               "Install it with: npm install @anthropic-ai/claude-agent-sdk",
      }
      yield { type: "done" }
      return
    }

    this.abortController = new AbortController()

    const self = this
    async function* messages() {
      yield {
        type: "user",
        session_id: "",
        parent_tool_use_id: null,
        message: { role: "user", content: input },
      }
    }

    try {
      // Build MCP server with custom tools (set_user_watch_project, set_preview_url, terminal_write, terminal_read)
      let mcpConfig: Record<string, any> | undefined
      try {
        const sdkMod = await import("@anthropic-ai/claude-agent-sdk")
        const toolFn = sdkMod.tool
        const createServer = sdkMod.createSdkMcpServer
        if (toolFn && createServer) {
          const z = (await import("zod")).default ?? (await import("zod"))
          const tools: any[] = []

          // ── set_user_watch_project ──
          tools.push(toolFn(
            "set_user_watch_project",
            `Let the user's frontend UI watch a project directory. This activates the file browser, diff viewer, and other project-related UI panels for the user. Call after creating a new project, cloning a repository, or when the user asks to open a specific project. Pass null to clear. If project is newly created, run git init first.`,
            { directory: z.string().nullable().describe("Absolute path to the project directory. Pass null to clear.") },
            async (args: any) => {
              self._emitEvent("directory.set", { directory: args.directory ?? "" })
              return { content: [{ type: "text" as const, text: args.directory ? `Working directory set to "${args.directory}".` : "Working directory cleared." }] }
            },
          ))

          // ── set_preview_url ──
          if (self.config.preview) {
            const preview = self.config.preview
            tools.push(toolFn(
              "set_preview_url",
              `Set the local URL to reverse-proxy for the user's preview tab. Call this after starting a dev server so the user can see the app in their preview panel.`,
              { forwarded_local_url: z.string().describe('The absolute local URL to reverse-proxy to (e.g. "http://localhost:5173").') },
              async (args: any) => {
                preview.setPreviewTarget(args.forwarded_local_url)
                return { content: [{ type: "text" as const, text: `Preview proxy set to "${args.forwarded_local_url}".` }] }
              },
            ))
          }

          // ── terminal_write ──
          if (self.config.terminal) {
            const terminal = self.config.terminal
            tools.push(toolFn(
              "terminal_write",
              `Manage a persistent user-visible terminal. Actions: "create" to spawn a new terminal, "input" to send text, "destroy" to kill the terminal. The terminal is visible to the user in their UI.`,
              {
                type: z.enum(["input", "create", "destroy"]).describe('Action type.'),
                content: z.string().optional().describe('Text to send when type is "input".'),
                pressEnter: z.boolean().optional().describe('Whether to press Enter after input. Defaults to true.'),
              },
              async (args: any) => {
                if (args.type === "create") {
                  terminal.create()
                  return { content: [{ type: "text" as const, text: "Terminal created." }] }
                }
                if (args.type === "destroy") {
                  terminal.destroy()
                  return { content: [{ type: "text" as const, text: "Terminal destroyed." }] }
                }
                // input
                if (!terminal.exists()) return { content: [{ type: "text" as const, text: 'No terminal exists. Use type "create" first.' }], isError: true }
                const pressEnter = args.pressEnter ?? true
                terminal.write(pressEnter ? (args.content ?? "") + "\n" : (args.content ?? ""))
                return { content: [{ type: "text" as const, text: "Input sent to terminal." }] }
              },
            ))

            // ── terminal_read ──
            tools.push(toolFn(
              "terminal_read",
              `Read the last N lines from the persistent user-visible terminal buffer. Use waitBefore to let a command finish before reading.`,
              {
                length: z.number().int().min(1).describe('Number of lines to read from the bottom of the terminal buffer.'),
                waitBefore: z.number().int().min(0).optional().describe('Milliseconds to wait before reading. Defaults to 0.'),
              },
              async (args: any) => {
                if (!terminal.exists()) return { content: [{ type: "text" as const, text: 'No terminal exists. Use terminal_write with type "create" first.' }], isError: true }
                const waitMs = Math.min(args.waitBefore ?? 0, 5000)
                if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs))
                const content = terminal.read(args.length)
                return { content: [{ type: "text" as const, text: content || "(terminal buffer is empty)" }] }
              },
            ))
          }

          if (tools.length > 0) {
            const server = createServer({ name: "anycode-tools", version: "1.0.0", tools })
            mcpConfig = { "anycode-tools": server }
          }
        }
      } catch { /* SDK tools unavailable, proceed without them */ }

      const stream = queryFn({
        prompt: messages(),
        options: {
          model: this.config.model || "sonnet",
          thinking: { type: "enabled", budgetTokens: 10000 },
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          baseTools: [{ preset: "default" }],
          deniedTools: ["AskUserQuestion"],
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...(this.config.apiKey ? { ANTHROPIC_API_KEY: this.config.apiKey } : {}),
            ...(this.config.baseUrl ? { ANTHROPIC_BASE_URL: this.config.baseUrl } : {}),
          },
          abortController: self.abortController,
          ...(mcpConfig ? { mcpServers: mcpConfig } : {}),
          // Resume previous session for conversation memory
          ...(this._claudeSessionId ? { resume: this._claudeSessionId } : {}),
        },
      })

      for await (const msg of stream) {
        // Capture session_id from the first message for conversation memory
        if (!this._claudeSessionId && (msg as any).session_id) {
          this._claudeSessionId = (msg as any).session_id
        }
        switch (msg.type) {
          // Streaming deltas — token-by-token output
          case "stream_event": {
            const evt = (msg as any).event
            if (!evt) break
            // content_block_delta: text or thinking delta
            if (evt.type === "content_block_delta") {
              const delta = evt.delta
              if (delta?.type === "text_delta") {
                yield {
                  type: "text.delta" as const,
                  content: delta.text ?? "",
                }
              } else if (delta?.type === "thinking_delta") {
                yield {
                  type: "thinking.delta" as const,
                  thinkingContent: delta.thinking ?? "",
                }
              }
            }
            // content_block_start: tool_use start
            if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
              yield {
                type: "tool.start" as const,
                toolCallId: evt.content_block.id ?? "",
                toolName: evt.content_block.name ?? "",
                toolArgs: evt.content_block.input ?? {},
              }
            }
            break
          }

          // Tool result messages
          case "user": {
            const blocks = (msg as any).message?.content ?? []
            for (const block of blocks) {
              if (block.type === "tool_result") {
                yield {
                  type: "tool.done" as const,
                  toolCallId: block.tool_use_id ?? "",
                  toolName: "",
                  toolOutput: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
                  toolTitle: "",
                  toolMetadata: {},
                }
              }
            }
            break
          }

          // Final result
          case "result": {
            if ((msg as any).result) {
              yield {
                type: "text.delta" as const,
                content: (msg as any).result,
              }
            }
            break
          }
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        // User cancelled — not an error
      } else {
        yield {
          type: "error" as const,
          error: err?.message ?? String(err),
        }
      }
    }

    yield { type: "done" as const }
  }

  /** Emit an event to all registered handlers (used by MCP tools) */
  private _emitEvent(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) ?? []
    for (const handler of handlers) handler(data)
  }

  abort(): void {
    this.abortController?.abort()
    this.abortController = null
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

/** Create the appropriate IChatAgent based on agent type string */
export function createChatAgent(agentType: string, config: ChatAgentConfig): IChatAgent {
  if (agentType === "claudecode") {
    return new ClaudeCodeAgent(config)
  }
  return new AnyCodeAgent(config)
}
