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

import { spawn, type ChildProcess } from "child_process"
import { createInterface, type Interface as ReadlineInterface } from "readline"
import { createRequire } from "module"

/**
 * Find the codex CLI binary path from the installed @openai/codex package.
 */
function findCodexBinaryPath(): string {
  const moduleReq = createRequire(import.meta.url)
  const { platform, arch } = process
  const PLATFORM_PACKAGE: Record<string, string> = {
    "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
    "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
    "x86_64-apple-darwin": "@openai/codex-darwin-x64",
    "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
    "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
    "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
  }
  let triple: string | null = null
  if (platform === "linux" || platform === "android") {
    triple = arch === "x64" ? "x86_64-unknown-linux-musl" : arch === "arm64" ? "aarch64-unknown-linux-musl" : null
  } else if (platform === "darwin") {
    triple = arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null
  } else if (platform === "win32") {
    triple = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : null
  }
  if (!triple) throw new Error(`Unsupported platform: ${platform} (${arch})`)
  const pkg = PLATFORM_PACKAGE[triple]
  if (!pkg) throw new Error(`No package for: ${triple}`)
  const { join, dirname } = require("path")
  const codexPkgJson = moduleReq.resolve("@openai/codex/package.json")
  const codexReq = createRequire(codexPkgJson)
  const platformPkgJson = codexReq.resolve(`${pkg}/package.json`)
  const vendorRoot = join(dirname(platformPkgJson), "vendor")
  const binaryName = platform === "win32" ? "codex.exe" : "codex"
  return join(vendorRoot, triple, "codex", binaryName)
}

/**
 * CodexAgent — uses `codex app-server` with JSON-RPC 2.0 over stdio.
 *
 * This provides true token-level streaming for agent text responses
 * via `item/agentMessage/delta` notifications, unlike the SDK's `codex exec`
 * which buffers the entire agent_message before emitting.
 */
export class CodexAgent implements IChatAgent {
  readonly name = "Codex Agent"
  readonly sessionId: string
  private config: ChatAgentConfig
  private eventHandlers = new Map<string, Array<(data: any) => void>>()
  private _workingDirectory: string = ""

  // App-server process state
  private _child: ChildProcess | null = null
  private _rl: ReadlineInterface | null = null
  private _rpcId = 0
  private _pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private _notificationListeners: Array<(notification: any) => void> = []
  private _initialized = false
  private _threadId: string | null = null
  private _turnActive = false

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.sessionId = `codex-${Date.now()}`
  }

  async ensureInit(): Promise<void> {
    await this._ensureAppServer()
  }

  on(event: string, handler: (data: any) => void): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  setWorkingDirectory(dir: string): void {
    this._workingDirectory = dir
  }

  getStats(): any { return null }

  async getSessionMessages(_opts: { limit: number }): Promise<any> { return [] }

  // ── App-server lifecycle ──

  private async _ensureAppServer(): Promise<void> {
    if (this._child && !this._child.killed) return

    let codexBin: string
    try {
      codexBin = findCodexBinaryPath()
    } catch {
      throw new Error("Codex CLI (@openai/codex) is not installed.")
    }

    // Build environment
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }

    const isOAuth = this.config.apiKey?.startsWith("oauth:")
    const isChatGptOAuth = this.config.apiKey === "chatgpt-oauth"

    if (isOAuth) {
      const parts = this.config.apiKey!.slice("oauth:".length).split(":")
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
            id_token: parts[2] || "",
            access_token: parts[0],
            ...(parts[1] ? { refresh_token: parts[1] } : {}),
          },
          last_refresh: new Date().toISOString(),
        }),
      )
      env.CODEX_HOME = codexHome
    } else if (isChatGptOAuth) {
      // Use CODEX_HOME from env (mounted auth.json)
    } else {
      if (this.config.apiKey) env.CODEX_API_KEY = this.config.apiKey
    }

    const args = ["app-server", "--listen", "stdio://", "--session-source", "exec"]
    if (!isChatGptOAuth && !isOAuth && this.config.baseUrl) {
      args.push("--config", `openai_base_url="${this.config.baseUrl}"`)
    }

    console.log(`[CodexAgent] Starting app-server: ${codexBin} ${args.join(" ")}`)
    this._child = spawn(codexBin, args, { env, stdio: ["pipe", "pipe", "pipe"] })

    this._child.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim()
      if (msg) console.log(`[CodexAgent stderr] ${msg}`)
    })

    this._child.on("exit", (code, signal) => {
      console.log(`[CodexAgent] app-server exited: code=${code} signal=${signal}`)
      this._child = null
      this._rl = null
      this._initialized = false
      this._threadId = null
      // Reject all pending requests
      for (const [, pending] of this._pendingRequests) {
        pending.reject(new Error("app-server exited"))
      }
      this._pendingRequests.clear()
    })

    this._rl = createInterface({ input: this._child.stdout!, crlfDelay: Infinity })
    this._rl.on("line", (line: string) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }

      // JSON-RPC response (has id + result/error)
      if ("id" in msg && (("result" in msg) || ("error" in msg))) {
        const pending = this._pendingRequests.get(msg.id)
        if (pending) {
          this._pendingRequests.delete(msg.id)
          if (msg.error) {
            pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          } else {
            pending.resolve(msg.result)
          }
        }
        return
      }

      // JSON-RPC notification (has method + params, no id)
      if ("method" in msg) {
        for (const listener of this._notificationListeners) {
          listener(msg)
        }
        return
      }

      // JSON-RPC server request (has method + params + id) — auto-approve
      if ("method" in msg && "id" in msg) {
        this._autoApproveServerRequest(msg)
      }
    })

    // Send initialize
    await this._sendRequest("initialize", {
      clientInfo: { name: "anycode-server", title: "AnyCode Server", version: "1.0.0" },
      capabilities: { experimentalApi: false },
    })

    this._initialized = true
    console.log("[CodexAgent] app-server initialized")
  }

  private _sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._child || this._child.killed) {
        return reject(new Error("app-server not running"))
      }
      const id = ++this._rpcId
      this._pendingRequests.set(id, { resolve, reject })
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params })
      this._child.stdin!.write(msg + "\n")
    })
  }

  private _autoApproveServerRequest(msg: any): void {
    // Auto-approve all approval requests (we run with full access)
    const id = msg.id
    let result: any = {}
    if (msg.method === "item/commandExecution/requestApproval") {
      result = { decision: "approve" }
    } else if (msg.method === "item/fileChange/requestApproval") {
      result = { decision: "approve" }
    } else if (msg.method === "item/permissions/requestApproval") {
      result = { decision: "approve" }
    } else if (msg.method === "account/chatgptAuthTokens/refresh") {
      // Can't refresh — just return empty
      result = { tokens: null }
    } else {
      // Unknown server request — respond with empty result
      result = {}
    }
    if (this._child && !this._child.killed) {
      this._child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
    }
  }

  // ── Chat ──

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    try {
      await this._ensureAppServer()
    } catch (err: any) {
      yield { type: "error" as const, error: err?.message ?? String(err) }
      yield { type: "done" as const }
      return
    }

    try {
      // Start thread if needed
      if (!this._threadId) {
        const threadResult = await this._sendRequest("thread/start", {
          model: this.config.model || "o4-mini",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          ...(this._workingDirectory ? { cwd: this._workingDirectory } : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })
        this._threadId = threadResult?.threadId ?? null
        if (!this._threadId) {
          // Thread ID may come from a thread/started notification
          // Wait briefly for notifications to arrive
          await new Promise(r => setTimeout(r, 200))
        }
      }

      if (!this._threadId) {
        yield { type: "error" as const, error: "Failed to start thread" }
        yield { type: "done" as const }
        return
      }

      // Set up a promise + notification listener for this turn
      let hasEmittedThinkingStart = false
      let hasEmittedThinkingEnd = false
      const eventQueue: ChatAgentEvent[] = []
      let turnDone = false
      let turnError: string | null = null
      let resolveTurn: (() => void) | null = null

      const notificationHandler = (msg: any) => {
        const method = msg.method as string
        const params = msg.params

        switch (method) {
          case "thread/started":
            if (!this._threadId && params?.threadId) {
              this._threadId = params.threadId
            }
            break

          case "item/agentMessage/delta":
            // Close thinking if still open
            if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
              hasEmittedThinkingEnd = true
              eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
            }
            eventQueue.push({ type: "text.delta", content: params.delta || "" })
            break

          case "item/reasoning/summaryTextDelta":
          case "item/reasoning/textDelta":
            if (!hasEmittedThinkingStart) {
              hasEmittedThinkingStart = true
              eventQueue.push({ type: "thinking.start" })
            }
            eventQueue.push({ type: "thinking.delta", thinkingContent: params.delta || "" })
            break

          case "item/started": {
            const item = params?.item
            if (!item) break
            if (item.type === "agentMessage") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
            } else if (item.type === "commandExecution") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
              eventQueue.push({
                type: "tool.start",
                toolCallId: item.id,
                toolName: "command_execution",
                toolArgs: { command: item.command },
              })
            } else if (item.type === "fileChange") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
              eventQueue.push({
                type: "tool.start",
                toolCallId: item.id,
                toolName: "file_change",
                toolArgs: { changes: item.changes },
              })
            } else if (item.type === "mcpToolCall") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
              eventQueue.push({
                type: "tool.start",
                toolCallId: item.id,
                toolName: item.tool || "mcp_tool",
                toolArgs: item.arguments ?? {},
              })
            }
            break
          }

          case "item/completed": {
            const item = params?.item
            if (!item) break
            if (item.type === "reasoning") {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
            } else if (item.type === "agentMessage") {
              // item.completed may arrive for short texts without any delta
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                eventQueue.push({ type: "thinking.end", thinkingDuration: 0 })
              }
              // Only emit text if we haven't already streamed it via deltas
              // (item.completed always contains full text)
            } else if (item.type === "commandExecution") {
              eventQueue.push({
                type: "tool.done",
                toolCallId: item.id,
                toolName: "command_execution",
                toolOutput: item.aggregatedOutput ?? "",
                toolTitle: item.command,
                toolMetadata: { exit_code: item.exitCode },
              })
            } else if (item.type === "fileChange") {
              eventQueue.push({
                type: "tool.done",
                toolCallId: item.id,
                toolName: "file_change",
                toolOutput: JSON.stringify(item.changes ?? []),
                toolTitle: "File changes",
                toolMetadata: { status: item.status },
              })
            } else if (item.type === "mcpToolCall") {
              eventQueue.push({
                type: "tool.done",
                toolCallId: item.id,
                toolName: item.tool || "mcp_tool",
                toolOutput: item.result ? JSON.stringify(item.result) : (item.error?.message ?? ""),
                toolTitle: item.tool || "MCP Tool",
                toolMetadata: { server: item.server, status: item.status },
              })
            }
            break
          }

          case "error": {
            const errMsg = params?.error?.message ?? "Unknown error"
            if (params?.willRetry) {
              console.log(`[CodexAgent] Retryable error: ${errMsg}`)
            } else {
              turnError = errMsg
              eventQueue.push({ type: "error", error: errMsg })
            }
            break
          }

          case "turn/completed":
            turnDone = true
            if (resolveTurn) resolveTurn()
            break
        }

        // Wake up the yield loop
        if (resolveTurn) resolveTurn()
      }

      this._notificationListeners.push(notificationHandler)

      try {
        // Start the turn
        this._turnActive = true
        this._sendRequest("turn/start", {
          threadId: this._threadId,
          input: [{ type: "text", text: input, text_elements: [] }],
          model: this.config.model || "o4-mini",
          approvalPolicy: "never",
          sandboxPolicy: "danger-full-access",
        }).catch(err => {
          turnError = err?.message ?? String(err)
          turnDone = true
          if (resolveTurn) resolveTurn()
        })

        // Yield events as they arrive
        while (!turnDone) {
          // Drain any queued events
          while (eventQueue.length > 0) {
            yield eventQueue.shift()!
          }
          // Wait for more events
          if (!turnDone) {
            await new Promise<void>(r => { resolveTurn = r })
            resolveTurn = null
          }
        }
        // Drain remaining events
        while (eventQueue.length > 0) {
          yield eventQueue.shift()!
        }

        if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
          yield { type: "thinking.end" as const, thinkingDuration: 0 }
        }
      } finally {
        this._turnActive = false
        const idx = this._notificationListeners.indexOf(notificationHandler)
        if (idx >= 0) this._notificationListeners.splice(idx, 1)
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        yield { type: "error" as const, error: err?.message ?? String(err) }
      }
    }

    yield { type: "done" as const }
  }

  abort(): void {
    if (this._turnActive && this._threadId) {
      this._sendRequest("turn/interrupt", { threadId: this._threadId }).catch(() => {})
    }
  }

  destroy(): void {
    if (this._child && !this._child.killed) {
      this._child.kill()
      this._child = null
    }
    this._rl = null
    this._initialized = false
    this._threadId = null
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
