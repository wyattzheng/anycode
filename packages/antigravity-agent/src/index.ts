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
import { createServer as createNetServer } from "net"
import { spawn, type ChildProcess } from "child_process"
import { tmpdir, platform } from "os"
import { join, dirname } from "path"
import { existsSync } from "fs"
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
  if (os !== "darwin") {
    throw new Error(`Unsupported platform: ${os}. Only macOS (darwin) is supported.`)
  }

  // Check bundled binary first
  const bundled = join(__dirname, "..", "bin", "language_server_macos_arm")
  if (existsSync(bundled)) return bundled

  // Fallback to Antigravity.app installation
  const appBin =
    "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm"
  if (existsSync(appBin)) return appBin

  throw new Error(
    "Go binary not found. Either:\n" +
    "  1. Place it in packages/antigravity-agent/bin/language_server_macos_arm\n" +
    "  2. Install Antigravity.app"
  )
}

const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"

export class AntigravityAgent implements IChatAgent {
  readonly name: string
  readonly sessionId: string
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

  /** Resolves when USS uss-oauth subscription is received and token injected */
  private _oauthInjected: Promise<void> | null = null
  private _oauthInjectedResolve: (() => void) | null = null

  constructor(config: ChatAgentConfig) {
    this.config = config
    this.name = config.name || "Antigravity Agent"
    this.sessionId = `antigravity-${Date.now()}`
    this.refreshToken = config.apiKey || ""
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

  async getSessionMessages(_opts: { limit: number }): Promise<any> {
    return []
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
      // Start cascade
      const startRes = await this._rpc("StartCascade")
      const cascadeId = startRes.cascadeId
      if (!cascadeId) {
        yield { type: "error", error: "Failed to start cascade" }
        yield { type: "done" }
        return
      }

      // Send message
      const sendRes = await this._rpc("SendUserCascadeMessage", {
        cascadeId,
        items: [{ text: input }],
        cascadeConfig: {
          plannerConfig: {
            planModel: 1026,
            maxOutputTokens: 8192,
            cascadeCanAutoRunCommands: true,
          },
        },
      })

      if (sendRes.code) {
        yield { type: "error", error: sendRes.message || "Send failed" }
        yield { type: "done" }
        return
      }

      // Poll for response
      let lastStepCount = 0
      let lastYieldedText = ""

      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1000))

        const traj = await this._rpc("GetAllCascadeTrajectories")
        const info = traj.trajectorySummaries?.[cascadeId]
        if (!info) continue

        const currentStepCount = info.stepCount || 0
        if (currentStepCount > lastStepCount) {
          const stepsRes = await this._rpc("GetCascadeTrajectorySteps", {
            cascadeId,
            startIndex: lastStepCount,
            endIndex: currentStepCount,
          })
          lastStepCount = currentStepCount

          for (const step of stepsRes.steps || []) {
            // AI text response
            if (step.plannerResponse?.response) {
              const text = step.plannerResponse.response
              if (text !== lastYieldedText) {
                yield { type: "text.delta" as const, content: text }
                lastYieldedText = text
              }
            }

            // Tool execution
            if (step.toolExecution) {
              const te = step.toolExecution
              yield {
                type: "tool.start" as const,
                toolCallId: te.id || "",
                toolName: te.toolName || te.tool || "unknown",
                toolArgs: te.toolParameters ?? {},
              }
              if (te.toolResult) {
                yield {
                  type: "tool.done" as const,
                  toolCallId: te.id || "",
                  toolName: te.toolName || te.tool || "unknown",
                  toolOutput: te.toolResult,
                  toolTitle: te.toolName || "",
                  toolMetadata: {},
                }
              }
            }
          }
        }

        // Check if cascade is done
        if (info.status?.includes("IDLE") && currentStepCount > 0) {
          break
        }
      }
    } catch (err: any) {
      yield { type: "error" as const, error: err?.message ?? String(err) }
    }

    yield { type: "done" as const }
  }

  abort(): void {
    if (this.binaryChild) {
      this.binaryChild.kill()
      this.binaryChild = null
    }
  }

  /** Destroy all managed resources */
  destroy(): void {
    this.abort()
    this.extServer?.close()
    this.pipeServer?.close()
    this.extServer = null
    this.pipeServer = null
    this.initialized = false
    this.initPromise = null
  }

  // ─── Private Methods ───────────────────────────────────────

  private async _refreshAccessToken(): Promise<void> {
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
            } catch {}

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
      const pipeServer = createNetServer(() => {})

      pipeServer.listen(pipePath, () => {
        this.pipeServer = pipeServer

        const child = spawn(binaryPath, [
          "--csrf_token", this.lsCsrf,
          "--random_port",
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
            try {
              resolve(JSON.parse(d))
            } catch {
              resolve(d)
            }
          })
        },
      )
      req.on("error", reject)
      req.write(data)
      req.end()
    })
  }
}
