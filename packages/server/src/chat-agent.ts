/**
 * IChatAgent — Unified chat agent interface for AnyCode.
 *
 * Abstracts over different agent backends (AnyCode native, Claude Code SDK, etc.)
 * so that the server's WebSocket chat handler only consumes a single interface.
 *
 * Controlled by the AGENT environment variable:
 *   AGENT=anycode     → AnyCodeAgent (default, wraps CodeAgent from @any-code/agent)
 *   AGENT=claudecode  → ClaudeCodeAgent (from @any-code/claude-code-agent)
 *   AGENT=codex       → CodexAgent (from @any-code/codex-agent)
 */

import { CodeAgent, type CodeAgentEvent, type CodeAgentOptions, type TerminalProvider, type PreviewProvider } from "@any-code/agent"
import type { IChatAgent, ChatAgentConfig, ChatAgentEvent } from "@any-code/utils"

// Re-export shared types for consumers
export type { IChatAgent, ChatAgentConfig, ChatAgentEvent }
export type { CodeAgentEvent }

// ── AnyCodeAgent ─────────────────────────────────────────────────────────

/**
 * AnyCodeAgent — internally creates and owns a CodeAgent instance.
 * Delegates all IChatAgent methods to the underlying CodeAgent.
 */
export class AnyCodeAgent implements IChatAgent {
  readonly name: string
  private config: ChatAgentConfig
  private _codeAgent: InstanceType<typeof CodeAgent>
  private _initialized = false

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.name = config.name || "AnyCode Agent"
    if (!config.codeAgentOptions) {
      throw new Error("AnyCodeAgent requires codeAgentOptions in ChatAgentConfig")
    }
    this._codeAgent = new CodeAgent(config.codeAgentOptions)
  }

  async init(): Promise<void> {
    if (!this._initialized) {
      this._initialized = true
      await this._codeAgent.init()
    }
  }

  get sessionId(): string {
    return this._codeAgent.sessionId
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    await this.init()
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

  async getUsage(): Promise<any> {
    return this._codeAgent.getUsage()
  }

  async getContext(): Promise<any> {
    return this._codeAgent.getContext()
  }

  getSessionMessages(opts: { limit: number }): Promise<any> {
    return this._codeAgent.getSessionMessages(opts)
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

/** Create the appropriate IChatAgent based on agent type string */
export async function createChatAgent(agentType: string, config: ChatAgentConfig): Promise<IChatAgent> {
  if (agentType === "claudecode") {
    const { ClaudeCodeAgent } = await import("@any-code/claude-code-agent")
    return new ClaudeCodeAgent(config)
  }
  if (agentType === "codex") {
    const { CodexAgent } = await import("@any-code/codex-agent")
    return new CodexAgent(config)
  }
  if (agentType === "antigravity") {
    const { AntigravityAgent } = await import("@any-code/antigravity-agent")
    return new AntigravityAgent(config)
  }
  return new AnyCodeAgent(config)
}
