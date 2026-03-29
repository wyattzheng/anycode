/**
 * @any-code/antigravity-agent — AntigravityAgent wrapping the Antigravity Go binary.
 *
 * Manages the lifecycle of:
 *   1. OAuth token refresh (refresh_token → access_token)
 *   2. Mock Extension Server with USS OAuth injection
 *   3. Go binary (language_server_macos_arm) spawn
 *   4. Cascade RPC for chat messaging
 *
 * API_KEY = Google OAuth refresh_token (obtained via scripts/get-token.mjs)
 *
 * The Go binary is bundled in bin/ — no dependency on Antigravity.app.
 */

import { createServer as createHttpServer, type Server as HttpServer } from "http"
import { request as httpsRequest } from "https"
import { createServer as createNetServer, type Server as NetServer } from "net"
import { spawn, type ChildProcess } from "child_process"
import { tmpdir, platform, homedir } from "os"
import { join, dirname } from "path"
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { fileURLToPath } from "url"
import { randomBytes, randomUUID } from "crypto"
import type { IChatAgent, ChatAgentEvent, ChatAgentConfig } from "@any-code/utils"
import {
  buildOAuthUSSUpdate,
  encodeEnvelope,
  protoEncodeBytes,
  decodeEnvelopes,
  protoDecodeFields,
  getSchemas,
} from "./proto.js"

export type { IChatAgent, ChatAgentEvent, ChatAgentConfig }
export { getSchemas }

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Resolve binary path — bundled in package bin/ directory */
function resolveBinaryPath(): string {
  const os = platform()
  const binaryMap: Record<string, string> = {
    "darwin": "language_server_macos_arm",
    "linux": "language_server_linux_x64",
  }

  const binaryName = binaryMap[os]
  if (!binaryName) {
    throw new Error(`Unsupported platform: ${os}. Supported: macOS (darwin), Linux.`)
  }

  // Check bundled binary first
  const bundled = join(__dirname, "..", "bin", binaryName)
  if (existsSync(bundled)) return bundled

  // Fallback to system installations
  if (os === "darwin") {
    const appBin = `/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/${binaryName}`
    if (existsSync(appBin)) return appBin
  } else if (os === "linux") {
    const sysPath = `/usr/share/antigravity/resources/app/extensions/antigravity/bin/${binaryName}`
    if (existsSync(sysPath)) return sysPath
  }

  throw new Error(
    `Go binary (${binaryName}) not found. Either:\n` +
    `  1. Place it in packages/antigravity-agent/bin/${binaryName}\n` +
    `  2. Install Antigravity on your system`
  )
}

const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"

const ANYCODE_DIR = join(homedir(), ".anycode")
const TOKEN_CACHE_PATH = join(ANYCODE_DIR, "oauth_token.json")

export class AntigravityAgent implements IChatAgent {
  readonly name: string
  private _cascadeId: string = ""
  private config: ChatAgentConfig
  private eventHandlers = new Map<string, Array<(data: any) => void>>()

  // Runtime state
  private lsCsrf = randomUUID()
  private extCsrf = randomUUID()
  private lsPort = 0
  private accessToken = ""
  private refreshToken = ""
  private extServer: HttpServer | null = null
  private binaryChild: ChildProcess | null = null
  private pipeServer: any = null
  private initialized = false
  private initPromise: Promise<void> | null = null

  // MCP tool bridge
  private _mcpBridgeServer: NetServer | null = null
  private _mcpBridgePort = 0
  private _toolDefinitions: Array<{ name: string; description: string; inputSchema: any }> = []
  private _toolInfos = new Map<string, any>()


  /** Resolves when USS uss-oauth subscription is received and token injected */
  private _oauthInjected: Promise<void> | null = null
  private _oauthInjectedResolve: (() => void) | null = null

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.name = config.name || "Antigravity Agent"
    this._cascadeId = config.sessionId || ""  // Empty until first chat() creates a cascade
    this.refreshToken = config.apiKey || ""
  }

  get sessionId(): string {
    return this._cascadeId
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this._doInit()
    await this.initPromise
    this.initialized = true
  }

  private async _doInit(): Promise<void> {
    if (!this.refreshToken) {
      throw new Error(
        "API_KEY (refresh_token) is required. " +
        "Run `node packages/antigravity-agent/scripts/get-token.mjs` to obtain one."
      )
    }

    // Validate binary exists
    const binaryPath = resolveBinaryPath()
    console.log(`[AntigravityAgent] Binary: ${binaryPath}`)

    // Load proto schemas (validates schemas.json exists)
    getSchemas()

    // Initialize custom tools from codeAgentOptions (same pattern as claude-code-agent)
    const tools: any[] = this.config.codeAgentOptions?.tools ?? []
    if (tools.length > 0) {
      console.log(`[AntigravityAgent] Initializing ${tools.length} custom tools...`)
      for (const toolDef of tools) {
        const info = await toolDef.init()
        this._toolInfos.set(toolDef.id, info)
        // Convert Zod schema to JSON Schema for MCP
        const zodShape = (info.parameters as any)?.shape ?? {}
        const properties: Record<string, any> = {}
        for (const [key, val] of Object.entries(zodShape)) {
          const desc = (val as any)?._def?.description || ""
          properties[key] = { type: "string", description: desc }
        }
        this._toolDefinitions.push({
          name: toolDef.id,
          description: info.description,
          inputSchema: { type: "object", properties },
        })
      }
      // Start TCP bridge for tool execution forwarding
      await this._startMcpBridge()
      console.log(`[AntigravityAgent] ✅ ${tools.length} tools registered on TCP port ${this._mcpBridgePort}`)
    }

    // 1. Exchange refresh_token for access_token
    console.log("[AntigravityAgent] Refreshing access token...")
    await this._refreshAccessToken()
    console.log("[AntigravityAgent] ✅ Access token obtained")

    // 2. Start mock extension server (sets up _oauthInjected promise)
    this._oauthInjected = new Promise((resolve) => {
      this._oauthInjectedResolve = resolve
    })
    console.log("[AntigravityAgent] Starting extension server...")
    const extPort = await this._startExtensionServer()
    console.log(`[AntigravityAgent] ✅ Extension server on port ${extPort}`)

    // 3. Spawn Go binary
    console.log("[AntigravityAgent] Spawning Go binary...")
    await this._spawnBinary(extPort, binaryPath)
    console.log(`[AntigravityAgent] ✅ Language server on port ${this.lsPort}`)

    // 4. Wait for USS uss-oauth subscription + injection (event-driven, not sleep!)
    console.log("[AntigravityAgent] Waiting for OAuth injection...")
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("OAuth injection timed out (30s)")), 30000)
    )
    await Promise.race([this._oauthInjected!, timeout])
    console.log("[AntigravityAgent] ✅ OAuth token injected via USS")
  }

  on(event: string, handler: (data: any) => void): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  setWorkingDirectory(_dir: string): void {
    // Binary manages its own working directory
  }

  async getUsage(): Promise<any> {
    return null
  }

  async getContext(): Promise<any> {
    return null
  }

  async getSessionMessages(opts: { limit: number }): Promise<any> {
    if (!this.initialized || !this.lsPort || !this._cascadeId) return []
    const limit = opts?.limit ?? 50

    // Query the current session's cascade trajectory
    const stepsRes = await this._rpc("GetCascadeTrajectorySteps", { cascadeId: this._cascadeId })
    const steps = stepsRes.steps || []
    console.log(`[getSessionMessages] cascadeId=${this._cascadeId}, ${steps.length} steps`)

    const messages: Array<{
      id: string; role: string; createdAt: number
      text?: string
      parts?: Array<{ type: string; tool?: string; content?: string }>
    }> = []

    let currentAssistantParts: Array<{ type: string; tool?: string; content?: string }> = []
    let currentAssistantText = ""
    let currentThinking = ""
    let hasAssistantContent = false

    for (const step of steps) {
      if (step.type === "CORTEX_STEP_TYPE_USER_INPUT") {
        if (hasAssistantContent) {
          messages.push({
            id: `assistant-${this._cascadeId}-${step.stepNumber || 0}`,
            role: "assistant",
            createdAt: new Date(step.metadata?.createdAt || 0).getTime() - 1,
            parts: [
              ...(currentThinking ? [{ type: "thinking", content: currentThinking }] : []),
              ...(currentAssistantText ? [{ type: "text", content: currentAssistantText }] : []),
              ...currentAssistantParts,
            ],
          })
          currentAssistantParts = []
          currentAssistantText = ""
          currentThinking = ""
          hasAssistantContent = false
        }

        const userText = step.userInput?.userResponse
          || step.userInput?.items?.map((it: any) => it.text).join("\n")
          || ""
        if (userText) {
          messages.push({
            id: `user-${this._cascadeId}-${step.stepNumber || 0}`,
            role: "user",
            createdAt: new Date(step.metadata?.createdAt || 0).getTime(),
            text: userText,
          })
        }
      } else if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
        hasAssistantContent = true
        if (step.plannerResponse?.thinking) currentThinking = step.plannerResponse.thinking
        if (step.plannerResponse?.response) currentAssistantText = step.plannerResponse.response
      } else if (step.type === "CORTEX_STEP_TYPE_MCP_TOOL") {
        hasAssistantContent = true
        const toolName = step.mcpTool?.toolCall?.name || "unknown"
        currentAssistantParts.push({ type: "tool", tool: toolName, content: "completed" })
      } else if ([
        "CORTEX_STEP_TYPE_LIST_DIRECTORY", "CORTEX_STEP_TYPE_VIEW_FILE",
        "CORTEX_STEP_TYPE_RUN_COMMAND", "CORTEX_STEP_TYPE_WRITE_FILE",
        "CORTEX_STEP_TYPE_GREP", "CORTEX_STEP_TYPE_FIND",
        "CORTEX_STEP_TYPE_CODE_ACTION", "CORTEX_STEP_TYPE_CREATE_FILE",
      ].includes(step.type)) {
        hasAssistantContent = true
        const toolName = step.type.replace("CORTEX_STEP_TYPE_", "").toLowerCase()
        currentAssistantParts.push({ type: "tool", tool: toolName, content: "completed" })
      }
    }

    // Flush final assistant message
    if (hasAssistantContent) {
      messages.push({
        id: `assistant-${this._cascadeId}-final`,
        role: "assistant",
        createdAt: Date.now(),
        parts: [
          ...(currentThinking ? [{ type: "thinking", content: currentThinking }] : []),
          ...(currentAssistantText ? [{ type: "text", content: currentAssistantText }] : []),
          ...currentAssistantParts,
        ],
      })
    }

    return messages.slice(-limit)
  }

  async *chat(input: string): AsyncGenerator<ChatAgentEvent, void, unknown> {
    if (!this.initialized) {
      try {
        await this.init()
      } catch (err: any) {
        yield { type: "error", error: err?.message ?? String(err) }
        yield { type: "done" }
        return
      }
    }



    try {
      // Always start a new cascade per chat() call (cascades close on completion)
      console.log(`[Cascade] chat() → StartCascade...`)
      const startRes = await this._rpc("StartCascade")
      this._cascadeId = startRes.cascadeId
      console.log(`[Cascade] chat() → cascadeId=${this._cascadeId}`)
      if (!this._cascadeId) {
        yield { type: "error", error: "Failed to start cascade" }
        yield { type: "done" }
        return
      }

      // Notify server to persist the cascadeId
      this._emitEvent("cascade.created", { cascadeId: this._cascadeId })

      // Build cascade config matching official client format
      const plannerConfig: any = {
        conversational: {
          plannerMode: "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
          agenticMode: true,
        },
        toolConfig: {
          runCommand: {
            autoCommandConfig: {
              autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER",
            },
          },
          notifyUser: {
            artifactReviewMode: "ARTIFACT_REVIEW_MODE_TURBO",
          },
        },
        requestedModel: {
          model: "MODEL_PLACEHOLDER_M26",
        },
        ephemeralMessagesConfig: { enabled: true },
        knowledgeConfig: { enabled: true },
      }

      // Inject custom tools as MCP servers
      if (this._toolDefinitions.length > 0) {
        const bridgePath = join(__dirname, "mcp-bridge.mjs")
        console.log(`[Cascade] Injecting ${this._toolDefinitions.length} MCP tools via bridge: ${bridgePath}`)
        console.log(`[Cascade] Tools: ${this._toolDefinitions.map((t: any) => t.name).join(", ")}`)
        plannerConfig.customizationConfig = {
          mcpServers: [{
            serverName: "anycode-tools",
            command: "node",
            args: [bridgePath],
            env: {
              ANYCODE_TOOLS_JSON: JSON.stringify(this._toolDefinitions),
              ANYCODE_MCP_PORT: String(this._mcpBridgePort),
              ANYCODE_MCP_DEBUG: "1",
            },
          }],
        }
      }

      const cascadeId = this._cascadeId
      // Send message
      console.log(`[Cascade] chat() → SendUserCascadeMessage to port ${this.lsPort}...`)
      let sendRes: any
      try {
        sendRes = await this._rpc("SendUserCascadeMessage", {
          cascadeId,
          items: [{ text: input }],
          cascadeConfig: {
            plannerConfig,
            conversationHistoryConfig: { enabled: true },
          },
          clientType: "CHAT_CLIENT_REQUEST_STREAM_CLIENT_TYPE_IDE",
        })
        console.log(`[Cascade] chat() → SendUserCascadeMessage response: ${JSON.stringify(sendRes).slice(0, 300)}`)
      } catch (err: any) {
        console.log(`[Cascade] chat() → SendUserCascadeMessage ERROR: ${err?.message}`)
        yield { type: "error", error: `SendUserCascadeMessage failed: ${err?.message}` }
        yield { type: "done" }
        return
      }

      if (sendRes.code) {
        console.log(`[Cascade] chat() → Send failed: ${sendRes.message}`)
        yield { type: "error", error: sendRes.message || "Send failed" }
        yield { type: "done" }
        return
      }

      console.log(`[Cascade] chat() → Streaming via StreamAgentStateUpdates`)

      // Event queue bridging stream events to generator yields  
      const eventQueue: any[] = []
      let queueDone = false
      let queueResolve: (() => void) | null = null

      const pushEvent = (event: any) => {
        eventQueue.push(event)
        if (queueResolve) { queueResolve(); queueResolve = null }
      }
      const waitForEvent = () => new Promise<void>(r => { queueResolve = r })

      // Shared state for step processing
      let lastYieldedText = ""
      let lastYieldedThinking = ""
      let resolvedTrajectoryId: string | null = null
      let hasEmittedThinkingStart = false
      let hasEmittedThinkingEnd = false
      let lastProcessedStepCount = 0

      // Process steps and push events to queue
      const processStepsToQueue = async () => {
        const stepsRes = await this._rpc("GetCascadeTrajectorySteps", { cascadeId })
        const allSteps = stepsRes.steps || []
        const currentStepCount = allSteps.length

        // Check all PLANNER_RESPONSE steps for streaming text + thinking
        for (const step of allSteps) {
          if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
            const thinking = step.plannerResponse?.thinking
            if (thinking && thinking !== lastYieldedThinking) {
              if (!hasEmittedThinkingStart) {
                hasEmittedThinkingStart = true
                pushEvent({ type: "thinking.start" })
              }
              const delta = thinking.startsWith(lastYieldedThinking)
                ? thinking.slice(lastYieldedThinking.length) : thinking
              if (delta) pushEvent({ type: "thinking.delta", thinkingContent: delta })
              lastYieldedThinking = thinking
            }
            const text = step.plannerResponse?.response
            if (text && text !== lastYieldedText) {
              if (hasEmittedThinkingStart && !hasEmittedThinkingEnd) {
                hasEmittedThinkingEnd = true
                const duration = step.plannerResponse?.thinkingDuration?.seconds || 0
                pushEvent({ type: "thinking.end", thinkingDuration: Number(duration) })
              }
              const delta = text.startsWith(lastYieldedText)
                ? text.slice(lastYieldedText.length) : text
              if (delta) pushEvent({ type: "text.delta", content: delta })
              lastYieldedText = text
            }
          }
        }

        if (currentStepCount > lastProcessedStepCount) {
          const newSteps = allSteps.slice(lastProcessedStepCount)
          lastProcessedStepCount = currentStepCount

          for (let si = 0; si < newSteps.length; si++) {
            const step = newSteps[si]
            const stepArrayIdx = lastProcessedStepCount - newSteps.length + si
            console.log(`[Cascade] step#${stepArrayIdx}: type=${step.type} status=${step.status}`)

            // Auto-approve WAITING steps
            if (step.status === "CORTEX_STEP_STATUS_WAITING") {
              const stepIdx = step.stepNumber ?? step.stepIndex ?? stepArrayIdx
              console.log(`[Cascade] ⚡ Auto-approving WAITING step#${stepIdx} (${step.type})`)
              if (!resolvedTrajectoryId) {
                try {
                  const trajRes = await this._rpc("GetCascadeTrajectory", { cascadeId })
                  resolvedTrajectoryId = trajRes.trajectory?.trajectoryId || null
                } catch { }
              }
              const tid = resolvedTrajectoryId || cascadeId
              const interactionBase: any = { trajectoryId: tid, stepIndex: stepIdx }
              const isFileTool = ["CORTEX_STEP_TYPE_LIST_DIRECTORY", "CORTEX_STEP_TYPE_VIEW_FILE",
                "CORTEX_STEP_TYPE_CODE_ACTION", "CORTEX_STEP_TYPE_CREATE_FILE"].includes(step.type)
              if (isFileTool) {
                let absPath = ""
                try {
                  const args = JSON.parse(step.metadata?.toolCall?.argumentsJson || step.toolCall?.argumentsJson || "{}")
                  absPath = args.DirectoryPath || args.AbsolutePath || args.TargetFile || args.path || ""
                } catch { }
                interactionBase.filePermission = { allow: true, scope: 2, absolutePathUri: absPath ? `file://${absPath}` : "" }
              } else if (step.type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
                interactionBase.runCommand = {}
              } else {
                interactionBase.codeAction = {}
              }
              try { await this._rpc("HandleCascadeUserInteraction", { cascadeId, interaction: interactionBase }) } catch { }
            }

            switch (step.type) {
              case "CORTEX_STEP_TYPE_PLANNER_RESPONSE": break

              case "CORTEX_STEP_TYPE_MCP_TOOL": {
                const mcp = step.mcpTool
                if (mcp?.toolCall) {
                  const mcpToolName = mcp.toolCall.name || "unknown"
                  let parsedArgs = {}
                  try { parsedArgs = JSON.parse(mcp.toolCall.argumentsJson || "{}") } catch { }
                  pushEvent({ type: "tool.start", toolCallId: mcp.toolCall.id || "", toolName: mcpToolName, toolArgs: parsedArgs })
                  if (step.status === "CORTEX_STEP_STATUS_DONE") {
                    pushEvent({
                      type: "tool.done", toolCallId: mcp.toolCall.id || "", toolName: mcpToolName,
                      toolOutput: mcp.resultString || "", toolTitle: `${mcp.serverName || "mcp"}:${mcpToolName}`,
                      toolMetadata: { serverName: mcp.serverName, serverVersion: mcp.serverInfo?.version },
                    })
                  }
                }
                break
              }

              case "CORTEX_STEP_TYPE_LIST_DIRECTORY":
              case "CORTEX_STEP_TYPE_VIEW_FILE":
              case "CORTEX_STEP_TYPE_RUN_COMMAND":
              case "CORTEX_STEP_TYPE_WRITE_FILE":
              case "CORTEX_STEP_TYPE_GREP":
              case "CORTEX_STEP_TYPE_FIND": {
                const toolName = step.type.replace("CORTEX_STEP_TYPE_", "").toLowerCase()
                const toolArgs = step.metadata?.toolCall?.argumentsJson ? JSON.parse(step.metadata.toolCall.argumentsJson) : {}
                pushEvent({ type: "tool.start", toolCallId: step.stepId || String(step.stepNumber || ""), toolName, toolArgs })
                if (step.status === "CORTEX_STEP_STATUS_DONE") {
                  const output = step.metadata?.toolCall?.result || step.listDirectory?.result || step.viewFile?.result || step.runCommand?.result || ""
                  pushEvent({
                    type: "tool.done", toolCallId: step.stepId || String(step.stepNumber || ""),
                    toolName, toolOutput: typeof output === "string" ? output : JSON.stringify(output), toolTitle: toolName, toolMetadata: {},
                  })
                }
                break
              }

              case "CORTEX_STEP_TYPE_ERROR_MESSAGE": {
                const errMsg = step.errorMessage?.error?.userErrorMessage || step.errorMessage?.error?.shortError || "Unknown error"
                pushEvent({ type: "error", error: errMsg })
                break
              }

              case "CORTEX_STEP_TYPE_CHECKPOINT":
              case "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE":
              case "CORTEX_STEP_TYPE_USER_INPUT":
              case "CORTEX_STEP_TYPE_CONVERSATION_HISTORY":
                break

              default:
                console.log(`[Cascade] unhandled step type: ${step.type}`, JSON.stringify(step).slice(0, 200))
                break
            }
          }
        }

        // Check completion
        if (currentStepCount > 0) {
          const lastStep = allSteps[allSteps.length - 1]
          if (lastStep?.status === "CORTEX_STEP_STATUS_DONE" && (
            lastStep?.type === "CORTEX_STEP_TYPE_CHECKPOINT" ||
            lastStep?.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE"
          )) {
            return true
          }
        }
        return false
      }

      // Start streaming loop in background
      const streamLoop = (async () => {
        try {
          // Build Connect frame: [flags=0x00][length: 4 bytes BE][JSON]
          const payload = JSON.stringify({
            conversationId: cascadeId,
            subscriberId: randomUUID(),
          })
          const payloadBuf = Buffer.from(payload, "utf8")
          const frame = Buffer.alloc(5 + payloadBuf.length)
          frame[0] = 0x00
          frame.writeUInt32BE(payloadBuf.length, 1)
          payloadBuf.copy(frame, 5)

          await new Promise<void>((resolve, reject) => {
            let streamDone = false

            const req = httpsRequest({
              hostname: "127.0.0.1",
              port: this.lsPort,
              path: "/exa.language_server_pb.LanguageServerService/StreamAgentStateUpdates",
              method: "POST",
              headers: {
                "Content-Type": "application/connect+json",
                "connect-protocol-version": "1",
                "x-codeium-csrf-token": this.lsCsrf,
                "Content-Length": frame.length,
              },
              rejectUnauthorized: false,
            }, (res) => {
              console.log(`[Cascade] Stream connected, status=${res.statusCode}`)
              let frameBuf = Buffer.alloc(0)

              res.on("data", async (chunk: Buffer) => {
                frameBuf = Buffer.concat([frameBuf, chunk])
                // Parse complete Connect frames
                while (frameBuf.length >= 5) {
                  const frameLen = frameBuf.readUInt32BE(1)
                  const totalLen = 5 + frameLen
                  if (frameBuf.length < totalLen) break
                  const flags = frameBuf[0]
                  frameBuf = frameBuf.slice(totalLen)

                  if (flags === 0x02) {
                    console.log(`[Cascade] Stream trailer (end)`)
                    streamDone = true
                    return
                  }

                  // Data frame received — fetch latest steps
                  try {
                    const complete = await processStepsToQueue()
                    if (complete) { streamDone = true; return }
                  } catch (e: any) {
                    console.log(`[Cascade] processSteps error: ${e.message}`)
                  }
                }
              })

              res.on("end", () => { streamDone = true; resolve() })
              res.on("error", (err) => {
                console.log(`[Cascade] Stream error: ${err.message}`)
                streamDone = true; resolve()
              })

              // Safety: also poll at slower interval in case we miss frames
              const safetyPoll = async () => {
                while (!streamDone) {
                  await new Promise(r => setTimeout(r, 500))
                  if (streamDone) break
                  try {
                    const complete = await processStepsToQueue()
                    if (complete) { streamDone = true; break }
                  } catch { }
                }
              }
              safetyPoll()
            })

            req.on("error", (err) => {
              console.log(`[Cascade] Stream connect failed: ${err.message}`)
              reject(err)
            })

            req.write(frame)
            req.end()
          })
        } catch {
          // Fallback to pure polling
          console.log(`[Cascade] Fallback to polling`)
          for (let i = 0; i < 400 && !queueDone; i++) {
            await new Promise(r => setTimeout(r, 300))
            try {
              const complete = await processStepsToQueue()
              if (complete) break
            } catch { }
          }
        }
        queueDone = true
        pushEvent(null)  // signal queue end
      })()

      // Consume events from queue and yield to caller
      while (true) {
        while (eventQueue.length > 0) {
          const ev = eventQueue.shift()
          if (ev === null) break
          yield ev
        }
        if (queueDone && eventQueue.length === 0) break
        await waitForEvent()
      }
    } catch (err: any) {
      yield { type: "error" as const, error: err?.message ?? String(err) }
    }



    yield { type: "done" as const }
  }

  abort(): void {
    if (this._cascadeId && this.lsPort) {
      console.log(`[Cascade] abort() → CancelCascadeInvocation cascadeId=${this._cascadeId}`)
      this._rpc("CancelCascadeInvocation", { cascadeId: this._cascadeId }).catch(() => {})
    }
  }

  /** Destroy all managed resources */
  destroy(): void {
    this.abort()
    this.extServer?.close()
    this.pipeServer?.close()
    this._mcpBridgeServer?.close()
    this.extServer = null
    this.pipeServer = null
    this._mcpBridgeServer = null
    this.initialized = false
    this.initPromise = null
  }

  // ─── Private Methods ───────────────────────────────────────

  /** Start TCP server for MCP bridge tool call forwarding */
  private _startMcpBridge(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createNetServer((socket) => {
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
            } catch { }
          }
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any
        this._mcpBridgePort = addr.port
        this._mcpBridgeServer = server
        resolve()
      })
      server.on("error", reject)
    })
  }

  /** Handle a tool call from the MCP bridge */
  private async _handleToolCall(id: any, toolName: string, args: any, socket: any): Promise<void> {
    try {
      const info = this._toolInfos.get(toolName)
      if (!info) {
        socket.write(JSON.stringify({ type: "tool_result", id, result: { output: `Unknown tool: ${toolName}` } }) + "\n")
        return
      }

      const self = this
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

  /** Emit an event to all registered handlers (used by MCP tools) */
  private _emitEvent(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) ?? []
    for (const handler of handlers) handler(data)
  }

  private async _refreshAccessToken(): Promise<void> {
    // Try reading cached token first
    try {
      const cached = JSON.parse(readFileSync(TOKEN_CACHE_PATH, "utf-8"))
      if (cached.access_token && cached.expires_at && Date.now() < cached.expires_at - 60_000) {
        this.accessToken = cached.access_token
        console.log("[AntigravityAgent] ✅ Using cached access token")
        return
      }
    } catch { /* cache miss or parse error — refresh from network */ }

    // Network refresh
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: this.refreshToken,
        grant_type: "refresh_token",
      })
      const req = httpsRequest(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        },
        (res) => {
          let d = ""
          res.on("data", (c: Buffer) => (d += c))
          res.on("end", () => {
            try {
              const json = JSON.parse(d)
              if (json.error) {
                reject(new Error(`OAuth error: ${json.error_description || json.error}`))
                return
              }
              this.accessToken = json.access_token
              // Cache token with expiry
              try {
                mkdirSync(ANYCODE_DIR, { recursive: true })
                writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({
                  access_token: json.access_token,
                  expires_at: Date.now() + (json.expires_in || 3600) * 1000,
                }), "utf-8")
              } catch { /* ignore cache write errors */ }
              resolve()
            } catch {
              reject(new Error(`Failed to parse token response: ${d}`))
            }
          })
        },
      )
      req.on("error", reject)
      req.write(params.toString())
      req.end()
    })
  }

  private _startExtensionServer(): Promise<number> {
    return new Promise((resolve) => {
      const server = createHttpServer((req, res) => {
        const rpcPath = req.url || ""

        let body: Buffer[] = []
        req.on("data", (chunk: Buffer) => body.push(chunk))
        req.on("end", () => {
          const rawBody = Buffer.concat(body)

          // USS subscription
          if (rpcPath.includes("SubscribeToUnifiedStateSyncTopic")) {
            let topic = ""
            try {
              const frames = decodeEnvelopes(rawBody)
              if (frames.length > 0) {
                topic = protoDecodeFields(frames[0].body).field1 || ""
              }
            } catch { }

            res.writeHead(200, {
              "Content-Type": "application/connect+proto",
              "Transfer-Encoding": "chunked",
            })
            res.flushHeaders()
            if (res.socket) res.socket.setNoDelay(true)

            if (topic === "uss-oauth" && this.accessToken) {
              const updateBuf = buildOAuthUSSUpdate(
                this.accessToken,
                this.refreshToken,
              )
              res.write(encodeEnvelope(updateBuf))
              // Signal that OAuth token has been injected
              this._oauthInjectedResolve?.()
            } else {
              // Empty initial_state for other topics
              res.write(encodeEnvelope(protoEncodeBytes(1, Buffer.alloc(0))))
            }
            return // Keep stream open
          }

          // All other RPCs: empty proto response
          res.writeHead(200, { "Content-Type": "application/proto" })
          res.end(Buffer.alloc(0))
        })
      })

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as any).port
        this.extServer = server
        resolve(port)
      })
    })
  }

  private _spawnBinary(extPort: number, binaryPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const pipePath = join(
        tmpdir(),
        `ag_agent_${randomBytes(4).toString("hex")}`,
      )
      const pipeServer = createNetServer(() => { })

      pipeServer.listen(pipePath, () => {
        this.pipeServer = pipeServer

        const child = spawn(binaryPath, [
          "--csrf_token", this.lsCsrf,
          "--https_server_port", "0",
          "--workspace_id", "anycode-agent",
          "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
          "--app_data_dir", "antigravity",
          "--extension_server_port", String(extPort),
          "--extension_server_csrf_token", this.extCsrf,
          "--parent_pipe_path", pipePath,
        ], { stdio: ["pipe", "pipe", "pipe"] })

        this.binaryChild = child

        child.stdin.write(Buffer.from([0x0a, 0x04, 0x74, 0x65, 0x73, 0x74]))
        child.stdin.end()

        let resolved = false
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true
            reject(new Error("Binary startup timed out (30s)"))
          }
        }, 30000)

        child.stderr.on("data", (d: Buffer) => {
          const text = d.toString()
          // Log all binary stderr for debugging
          for (const line of text.split("\n")) {
            if (line.trim()) console.log(`[Binary] ${line}`)
          }
          const m = text.match(
            /listening on random port at (\d+) for HTTPS/,
          )
          if (m && !resolved) {
            resolved = true
            clearTimeout(timeout)
            this.lsPort = parseInt(m[1])
            resolve()
          }
        })

        child.on("error", (err) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            reject(err)
          }
        })

        child.on("exit", (code) => {
          if (!resolved) {
            resolved = true
            clearTimeout(timeout)
            reject(new Error(`Binary exited with code ${code}`))
          }
        })
      })
    })
  }

  private _rpc(method: string, body: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const timeout = setTimeout(() => {
        req.destroy()
        reject(new Error(`RPC ${method} timed out after 30s`))
      }, 30000)
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: this.lsPort,
          path: `/exa.language_server_pb.LanguageServerService/${method}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-codeium-csrf-token": this.lsCsrf,
            "Content-Length": Buffer.byteLength(data),
            Connection: "close",
          },
          rejectUnauthorized: false,
        },
        (res) => {
          let d = ""
          res.on("data", (c: Buffer) => (d += c))
          res.on("end", () => {
            clearTimeout(timeout)
            try {
              resolve(JSON.parse(d))
            } catch {
              resolve(d)
            }
          })
        },
      )
      req.on("error", (err) => {
        clearTimeout(timeout)
        reject(err)
      })
      req.write(data)
      req.end()
    })
  }
}
