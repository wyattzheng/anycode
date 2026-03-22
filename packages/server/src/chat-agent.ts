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

import { CodeAgent, type CodeAgentEvent, type CodeAgentOptions } from "@any-code/agent"

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
      const stream = queryFn({
        prompt: messages(),
        options: {
          model: this.config.model || "sonnet",
          apiKey: this.config.apiKey,
          ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
          baseTools: [{ preset: "default" }],
          deniedTools: ["AskUserQuestion"],
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...(this.config.apiKey ? { ANTHROPIC_API_KEY: this.config.apiKey } : {}),
            ...(this.config.baseUrl ? { ANTHROPIC_BASE_URL: this.config.baseUrl } : {}),
          },
          abortController: self.abortController,
        },
      })

      for await (const msg of stream) {
        switch (msg.type) {
          case "text":
          case "text_delta":
            yield {
              type: "text.delta" as const,
              content: msg.delta ?? msg.text ?? "",
            }
            break

          case "tool_use":
            yield {
              type: "tool.start" as const,
              toolCallId: msg.tool_use_id ?? msg.id ?? "",
              toolName: msg.name ?? "",
              toolArgs: msg.input ?? {},
            }
            break

          case "tool_result":
            yield {
              type: "tool.done" as const,
              toolCallId: msg.tool_use_id ?? msg.id ?? "",
              toolName: msg.name ?? "",
              toolOutput: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
              toolTitle: msg.name ?? "",
              toolMetadata: {},
            }
            break

          case "thinking":
            yield {
              type: "thinking.delta" as const,
              thinkingContent: msg.thinking ?? msg.delta ?? "",
            }
            break

          case "result":
            if (msg.result) {
              yield {
                type: "text.delta" as const,
                content: msg.result,
              }
            }
            break
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
