/**
 * @any-code/codex-agent — CodexAgent wrapping @openai/codex-sdk.
 *
 * Uses dynamic import to avoid hard dependency on the SDK package.
 * Spawns the Codex CLI via the SDK, maps ThreadEvent → ChatAgentEvent.
 *
 * Also exposes 4 custom AnyCode tools to the Codex CLI via a lightweight
 * MCP server bridge (codex-mcp-bridge.cjs) that communicates back over TCP.
 */

import { createServer as createTcpServer, type Server as TcpServer } from "net"
import { statSync } from "fs"
import { join, dirname } from "path"
import type { IChatAgent, ChatAgentEvent, ChatAgentConfig } from "@any-code/utils"

export type { IChatAgent, ChatAgentEvent, ChatAgentConfig }

export class CodexAgent implements IChatAgent {
  readonly name: string
  readonly sessionId: string
  private config: ChatAgentConfig
  private abortController: AbortController | null = null
  private eventHandlers = new Map<string, Array<(data: any) => void>>()
  private _codex: any = null
  private _thread: any = null
  private _workingDirectory: string = ""
  private _mcpServer: TcpServer | null = null
  private _mcpPort: number = 0

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.name = config.name || "Codex Agent"
    this.sessionId = `codex-${Date.now()}`
  }

  async init(): Promise<void> {
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

  async getUsage(): Promise<any> {
    return null
  }

  async getContext(): Promise<any> {
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
      // Start MCP bridge TCP server if not already running
      if (!this._mcpServer) {
        await this._startMcpBridge()
      }

      // Lazily create the Codex instance
      if (!this._codex) {
        // Find MCP bridge script path (next to the bundled dist output)
        const bridgePath = join(dirname(new URL(import.meta.url).pathname), "codex-mcp-bridge.cjs")

        // MCP server config to inject into Codex CLI
        const mcpConfig = {
          mcp_servers: {
            "anycode-tools": {
              type: "stdio",
              command: "node",
              args: [bridgePath],
              env: { ANYCODE_MCP_PORT: String(this._mcpPort) },
            }
          }
        }

        const isOAuth = this.config.apiKey?.startsWith("oauth:")
        if (isOAuth) {
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
          this._codex = new Codex({
            ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
            env: { ...process.env, CODEX_HOME: codexHome, ANYCODE_MCP_PORT: String(this._mcpPort) } as Record<string, string>,
            config: mcpConfig,
          })
        } else {
          const skipApiKey = this.config.apiKey === "chatgpt-oauth"
          this._codex = new Codex({
            ...(!skipApiKey && this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
            ...(!skipApiKey && this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
            env: { ...process.env, ANYCODE_MCP_PORT: String(this._mcpPort) } as Record<string, string>,
            config: mcpConfig,
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
            if (msg === "Unknown error") {
              console.error("[CodexAgent] Unexpected error event:", JSON.stringify(event));
            }
            // Codex CLI emits transient reconnection errors internally — suppress them
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

  /** Emit an event to all registered handlers (used by MCP tools) */
  private _emitEvent(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) ?? []
    for (const handler of handlers) handler(data)
  }

  /** Start TCP server for MCP bridge tool call forwarding */
  private _startMcpBridge(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createTcpServer((socket) => {
        let buffer = ""
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString()
          let newlineIdx
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx)
            buffer = buffer.slice(newlineIdx + 1)
            try {
              const msg = JSON.parse(line)
              if (msg.type === "tool_call") {
                this._handleToolCall(msg.id, msg.toolName, msg.args, socket)
              }
            } catch {}
          }
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any
        this._mcpPort = addr.port
        this._mcpServer = server
        console.log(`[CodexAgent] MCP bridge TCP server on port ${this._mcpPort}`)
        resolve()
      })
      server.on("error", reject)
    })
  }

  /** Handle a tool call from the MCP bridge */
  private async _handleToolCall(id: number, toolName: string, args: any, socket: any): Promise<void> {
    try {
      const tools: any[] = this.config.codeAgentOptions?.tools ?? []
      const toolDef = tools.find((t: any) => t.id === toolName)

      if (!toolDef) {
        socket.write(JSON.stringify({ type: "tool_result", id, result: { output: `Unknown tool: ${toolName}` } }) + "\n")
        return
      }

      const self = this
      const info = await toolDef.init()
      const ctx = {
        emit: (event: string, data?: any) => self._emitEvent(event, data),
        terminal: self.config.terminal,
        preview: self.config.preview,
        worktree: "",
        fs: {
          async stat(p: string) {
            try { const s = statSync(p); return { isDirectory: s.isDirectory(), isFile: s.isFile() } }
            catch { return null }
          }
        },
      }
      const result = await info.execute(args, ctx as any)
      socket.write(JSON.stringify({ type: "tool_result", id, result: { output: result.output } }) + "\n")
    } catch (err: any) {
      socket.write(JSON.stringify({ type: "tool_result", id, error: err?.message ?? String(err) }) + "\n")
    }
  }

  abort(): void {
    this.abortController?.abort()
    this.abortController = null
  }
}
