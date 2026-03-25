/**
 * Shared ChatAgent interfaces for @any-code ecosystem.
 *
 * These types are consumed by:
 *   - @any-code/server (AnyCodeAgent + factory)
 *   - @any-code/codex-agent
 *   - @any-code/claude-code-agent
 */

/**
 * Unified event type emitted by all ChatAgent backends.
 * Matches the CodeAgentEvent shape from @any-code/agent.
 */
export interface ChatAgentEvent {
  type: string
  [key: string]: any
}

/**
 * Unified configuration for all ChatAgent backends.
 * Each backend picks the fields it needs.
 *
 * NOTE: `codeAgentOptions`, `terminal`, and `preview` are typed as `any`
 * to avoid @any-code/utils depending on @any-code/agent.
 * Each agent package casts internally.
 */
export interface ChatAgentConfig {
  apiKey: string
  model: string
  baseUrl?: string
  /** AnyCode-specific: full CodeAgentOptions for internal CodeAgent creation */
  codeAgentOptions?: any
  /** Terminal provider for the session (used by ClaudeCodeAgent MCP tools) */
  terminal?: any
  /** Preview provider for the session (used by ClaudeCodeAgent MCP tools) */
  preview?: any
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
