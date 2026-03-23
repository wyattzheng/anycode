/**
 * IChatAgent — Unified chat agent interface for AnyCode.
 *
 * Abstracts over different agent backends (AnyCode native, Claude Code SDK, etc.)
 * so that the server's WebSocket chat handler only consumes a single interface.
 *
 * Controlled by the AGENT environment variable:
 *   AGENT=anycode     → AnyCodeAgent (default, wraps CodeAgent from @any-code/agent)
 *   AGENT=claudecode  → ClaudeCodeAgent (wraps @anthropic-ai/claude-agent-sdk)
 *   AGENT=codex       → CodexAgent (wraps @openai/codex-sdk)
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

  async getSessionMessages(opts: { limit: number }): Promise<any> {
    if (!this._claudeSessionId) return []
    let sdk: any
    try {
      // @ts-ignore
      sdk = await import("@anthropic-ai/claude-agent-sdk")
    } catch {
      return []
    }
    
    if (typeof sdk.getSessionMessages !== "function") return []
    
    try {
      const dbMsgs = await sdk.getSessionMessages(this._claudeSessionId)
      const limit = opts?.limit ?? 50
      const recent = dbMsgs.slice(-limit)
      
      const merged: any[] = []
      
      for (const m of recent) {
        const msg = m.message || {}
        const role = msg.role || m.type || "unknown"
        
        const simplified: any = {
          id: msg.id || m.uuid || "",
          role: role === "assistant" ? "assistant" : "user",
          createdAt: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
        }
        
        const contentBlocks = Array.isArray(msg.content) ? msg.content : typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : []
        
        if (simplified.role === "user") {
          simplified.text = contentBlocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
        } else {
          simplified.parts = contentBlocks.map((b: any) => {
            if (b.type === "text") return { type: "text", content: b.text || "" }
            if (b.type === "thinking" || b.type === "redacted_thinking") return { type: "thinking", content: b.thinking || "" }
            if (b.type === "tool_use" || b.type === "server_tool_use") return { type: "tool", tool: b.name, content: "Executed tool " + b.name }
            return { type: b.type }
          })
        }
        
        const last = merged[merged.length - 1]
        if (last && last.role === "assistant" && simplified.role === "assistant") {
          // Merge adjacent assistant messages to render as a single chat bubble
          if (!last.parts) last.parts = []
          if (simplified.parts) last.parts.push(...simplified.parts)
        } else {
          merged.push(simplified)
        }
      }
      
      return merged
    } catch (err) {
      console.error("[ClaudeCodeAgent] Failed to fetch session history:", err)
      return []
    }
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
        message: { role: "user", content: [{ type: "text", text: input }] },
      }
    }

    let hasEmittedThinkingStart = false
    let hasEmittedThinkingEnd = false

    const activeToolCalls = new Map<number, { id: string, name: string, argsStr: string }>()

    try {
      // Build MCP server with custom tools bridged from @any-code/agent extraTools
      let mcpConfig: Record<string, any> | undefined
      try {
        const sdkMod = await import("@anthropic-ai/claude-agent-sdk")
        const toolFn = sdkMod.tool
        const createServer = sdkMod.createSdkMcpServer
        if (toolFn && createServer) {
          const extraTools = self.config.codeAgentOptions?.extraTools ?? []
          if (extraTools.length > 0) {
            // Lightweight context proxy for Tool.execute()
            const makeCtx = () => ({
              emit: (event: string, data?: any) => self._emitEvent(event, data),
              terminal: self.config.terminal || { create() {}, destroy() {}, exists: () => false, write() {}, read: () => "" },
              preview: self.config.preview || { setPreviewTarget() {} },
              fs: { stat: async (p: string) => { try { const s = (await import("fs")).statSync(p); return { isDirectory: s.isDirectory(), isFile: s.isFile() } } catch { return null } } },
              worktree: "",
            })

            const sdkTools: any[] = []
            for (const toolDef of extraTools) {
              const info = await toolDef.init()
              // Extract Zod shape from z.object() for SDK tool() — SDK expects raw shape, not z.object()
              const shape = (info.parameters as any)?.shape ?? {}
              sdkTools.push(toolFn(
                toolDef.id,
                info.description,
                shape,
                async (args: any) => {
                  try {
                    const result = await info.execute(args, makeCtx() as any)
                    return { content: [{ type: "text" as const, text: result.output }] }
                  } catch (err: any) {
                    return { content: [{ type: "text" as const, text: err.message || String(err) }], isError: true }
                  }
                },
              ))
            }

            if (sdkTools.length > 0) {
              const server = createServer({ name: "anycode-tools", version: "1.0.0", tools: sdkTools })
              mcpConfig = { "anycode-tools": server }
            }
          }
        }
      } catch (err) { 
        console.error("[ClaudeCode MCP Error]", err)
      }

      let capturedStderr = ""
      const stream = queryFn({
        prompt: messages(),
        options: {
          model: this.config.model || "sonnet",
          thinking: { type: "enabled", budgetTokens: 10000 },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          canUseTool: async () => ({ behavior: 'allow' as const }),
          baseTools: [{ preset: "default" }],
          disallowedTools: ["AskUserQuestion"],
          cwd: process.cwd(),
          stderr: (data: string) => {
            console.error("[ClaudeCode Stderr]", data)
            capturedStderr += data + "\n"
          },
          env: {
            ...process.env,
            IS_SANDBOX: "1",
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
                if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                  hasEmittedThinkingEnd = true
                  yield { type: "thinking.end" as const, thinkingDuration: 0 }
                }
                yield {
                  type: "text.delta" as const,
                  content: delta.text ?? "",
                }
              } else if (delta?.type === "thinking_delta") {
                if (!hasEmittedThinkingStart) {
                  hasEmittedThinkingStart = true
                  yield { type: "thinking.start" as const }
                }
                yield {
                  type: "thinking.delta" as const,
                  thinkingContent: delta.thinking ?? "",
                }
              } else if (delta?.type === "input_json_delta") {
                const toolCall = activeToolCalls.get(evt.index)
                if (toolCall) {
                  toolCall.argsStr += delta.partial_json ?? ""
                }
              }
            }
            // content_block_start: tool_use start
            if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
              activeToolCalls.set(evt.index, {
                id: evt.content_block.id ?? "",
                name: evt.content_block.name ?? "",
                argsStr: ""
              })
            }
            // content_block_stop: emit tool.start with fully parsed arguments
            if (evt.type === "content_block_stop") {
              const toolCall = activeToolCalls.get(evt.index)
              if (toolCall) {
                let parsedArgs = {}
                try {
                  parsedArgs = JSON.parse(toolCall.argsStr)
                } catch { /* ignore */ }
                
                yield {
                  type: "tool.start" as const,
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  toolArgs: parsedArgs,
                }
                activeToolCalls.delete(evt.index)
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
            // Re-yielding the full result causes duplicate messages on the UI
            // because the text was already streamed token-by-token via 'stream_event'.
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

    if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
      yield { type: "thinking.end" as const, thinkingDuration: 0 }
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

// ── CodexAgent ───────────────────────────────────────────────────────────

/**
 * CodexAgent — wraps @openai/codex-sdk.
 *
 * Uses dynamic import to avoid hard dependency on the SDK package.
 * Spawns the Codex CLI via the SDK, maps ThreadEvent → ChatAgentEvent.
 */
export class CodexAgent implements IChatAgent {
  readonly name = "Codex Agent"
  readonly sessionId: string
  private config: ChatAgentConfig
  private abortController: AbortController | null = null
  private eventHandlers = new Map<string, Array<(data: any) => void>>()
  private _codex: any = null
  private _thread: any = null
  private _workingDirectory: string = ""
  private _oauthProviderPrefix: string = ""

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.sessionId = `codex-${Date.now()}`
  }

  async ensureInit(): Promise<void> {
    // Codex handles initialization internally when starting a thread
  }

  on(event: string, handler: (data: any) => void): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  setWorkingDirectory(dir: string): void {
    this._workingDirectory = dir
  }

  getStats(): any {
    return null
  }

  async getSessionMessages(_opts: { limit: number }): Promise<any> {
    return []
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    let Codex: any
    try {
      const sdk = await import("@openai/codex-sdk")
      Codex = sdk.Codex
    } catch {
      yield {
        type: "error",
        error: "Codex SDK (@openai/codex-sdk) is not installed. " +
          "Install it with: npm install @openai/codex-sdk",
      }
      yield { type: "done" }
      return
    }

    this.abortController = new AbortController()

    try {
      // Lazily create the Codex instance
      if (!this._codex) {
        const isOAuth = this.config.apiKey?.startsWith("oauth:")
        if (isOAuth) {
          // Format: oauth:<access_token>:<refresh_token>:<id_token>
          // Write auth.json to a dedicated CODEX_HOME dir and inject via env.
          const parts = this.config.apiKey!.slice("oauth:".length).split(":")
          const accessToken = parts[0]
          const refreshToken = parts[1] || ""
          const idToken = parts[2] || ""

          const fs = await import("fs")
          const path = await import("path")
          const os = await import("os")
          const codexHome = path.join(os.homedir(), ".codex-oauth")
          fs.mkdirSync(codexHome, { recursive: true })
          fs.writeFileSync(
            path.join(codexHome, "auth.json"),
            JSON.stringify({
              auth_mode: "chatgpt",
              OPENAI_API_KEY: null,
              tokens: {
                id_token: idToken,
                access_token: accessToken,
                ...(refreshToken ? { refresh_token: refreshToken } : {}),
              },
              last_refresh: new Date().toISOString(),
            }),
          )
          // Pass CODEX_HOME via env, don't pass apiKey (let CLI use auth.json)
          this._codex = new Codex({
            ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
            env: { ...process.env, CODEX_HOME: codexHome } as Record<string, string>,
          })
        } else {
          // "chatgpt-oauth" is a sentinel meaning "use OAuth auth from mounted auth.json"
          // Don't pass apiKey or baseUrl — let CLI use its own defaults for OAuth mode.
          const skipApiKey = this.config.apiKey === "chatgpt-oauth"
          this._codex = new Codex({
            ...(!skipApiKey && this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
            ...(!skipApiKey && this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
          })
        }
      }

      // Reuse thread for multi-turn conversation, or start a new one
      if (!this._thread) {
        this._thread = this._codex.startThread({
          model: this.config.model || "o4-mini",
          ...(this._workingDirectory ? { workingDirectory: this._workingDirectory } : {}),
          approvalPolicy: "never",
          sandboxMode: "danger-full-access",
          skipGitRepoCheck: true,
        })
      }

      const { events } = await this._thread.runStreamed(input, {
        signal: this.abortController.signal,
      })

      let hasEmittedThinkingStart = false
      let hasEmittedThinkingEnd = false

      for await (const event of events) {
        switch (event.type) {
          case "item.started": {
            const item = (event as any).item
            if (item.type === "reasoning") {
              if (!hasEmittedThinkingStart) {
                hasEmittedThinkingStart = true
                yield { type: "thinking.start" as const }
              }
              if (item.text) {
                yield { type: "thinking.delta" as const, thinkingContent: item.text }
              }
            } else if (item.type === "agent_message") {
              // Close thinking if still open
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                yield { type: "thinking.end" as const, thinkingDuration: 0 }
              }
              if (item.text) {
                yield { type: "text.delta" as const, content: item.text }
              }
            } else if (item.type === "command_execution") {
              yield {
                type: "tool.start" as const,
                toolCallId: item.id,
                toolName: "command_execution",
                toolArgs: { command: item.command },
              }
            } else if (item.type === "file_change") {
              yield {
                type: "tool.start" as const,
                toolCallId: item.id,
                toolName: "file_change",
                toolArgs: { changes: item.changes },
              }
            } else if (item.type === "mcp_tool_call") {
              yield {
                type: "tool.start" as const,
                toolCallId: item.id,
                toolName: item.tool || "mcp_tool",
                toolArgs: item.arguments ?? {},
              }
            }
            break
          }

          case "item.updated": {
            const item = (event as any).item
            if (item.type === "reasoning" && item.text) {
              if (!hasEmittedThinkingStart) {
                hasEmittedThinkingStart = true
                yield { type: "thinking.start" as const }
              }
              yield { type: "thinking.delta" as const, thinkingContent: item.text }
            } else if (item.type === "agent_message" && item.text) {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                yield { type: "thinking.end" as const, thinkingDuration: 0 }
              }
              yield { type: "text.delta" as const, content: item.text }
            }
            break
          }

          case "item.completed": {
            const item = (event as any).item
            if (item.type === "reasoning") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                yield { type: "thinking.end" as const, thinkingDuration: 0 }
              }
            } else if (item.type === "agent_message") {
              // For short text responses, the SDK may emit item.completed directly
              // (skipping item.started/item.updated), so we must yield text here too.
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                yield { type: "thinking.end" as const, thinkingDuration: 0 }
              }
              if (item.text) {
                yield { type: "text.delta" as const, content: item.text }
              }
            } else if (item.type === "command_execution") {
              yield {
                type: "tool.done" as const,
                toolCallId: item.id,
                toolName: "command_execution",
                toolOutput: item.aggregated_output ?? "",
                toolTitle: item.command,
                toolMetadata: { exit_code: item.exit_code },
              }
            } else if (item.type === "file_change") {
              yield {
                type: "tool.done" as const,
                toolCallId: item.id,
                toolName: "file_change",
                toolOutput: JSON.stringify(item.changes ?? []),
                toolTitle: "File changes",
                toolMetadata: { status: item.status },
              }
            } else if (item.type === "mcp_tool_call") {
              yield {
                type: "tool.done" as const,
                toolCallId: item.id,
                toolName: item.tool || "mcp_tool",
                toolOutput: item.result ? JSON.stringify(item.result) : (item.error?.message ?? ""),
                toolTitle: item.tool || "MCP Tool",
                toolMetadata: { server: item.server, status: item.status },
              }
            }
            break
          }

          case "turn.failed": {
            const err = (event as any).error
            yield {
              type: "error" as const,
              error: err?.message ?? "Turn failed",
            }
            break
          }

          case "error": {
            const msg = (event as any).message ?? "Unknown error"
            // Codex CLI emits transient reconnection errors internally — suppress them
            // since the CLI's retry logic handles recovery automatically.
            if (/Reconnecting\.{3}/.test(msg)) {
              console.log(`[CodexAgent] ${msg}`)
              break
            }
            yield {
              type: "error" as const,
              error: msg,
            }
            break
          }

          // thread.started, turn.started, turn.completed — no mapping needed
          default:
            break
        }
      }

      if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
        yield { type: "thinking.end" as const, thinkingDuration: 0 }
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
  if (agentType === "codex") {
    return new CodexAgent(config)
  }
  return new AnyCodeAgent(config)
}
