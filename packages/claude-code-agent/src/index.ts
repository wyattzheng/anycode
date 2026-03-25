/**
 * @any-code/claude-code-agent — ClaudeCodeAgent wrapping @anthropic-ai/claude-agent-sdk.
 *
 * Uses dynamic import to avoid hard dependency on the SDK package.
 * Maps Claude SDK events to standard ChatAgentEvent (CodeAgentEvent) format.
 * Session-level methods (on, setWorkingDirectory, etc.) are no-ops.
 */

import type { IChatAgent, ChatAgentEvent, ChatAgentConfig } from "@any-code/utils"

export type { IChatAgent, ChatAgentEvent, ChatAgentConfig }

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
