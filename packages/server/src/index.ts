/**
 * any-code-server — API server for CodeAgent
 *
 * Starts a lightweight HTTP server that:
 *   1. Exposes POST /api/chat (SSE) to stream agent responses
 *   2. Frontend is served separately by the app package
 *
 * Environment variables:
 *   PROVIDER    — LLM provider id  (default: "anthropic")
 *   MODEL       — LLM model id     (default: "claude-sonnet-4-20250514")
 *   API_KEY     — Provider API key  (required)
 *   BASE_URL    — Custom API base URL (optional)
 *   PORT        — HTTP port         (default: 3210)
 */

import http from "http"
import path from "path"
import os from "os"
import fs from "fs"
import { execFile, spawn as cpSpawn } from "child_process"
import { CodeAgent } from "@any-code/agent"
import { SqlJsStorage } from "./storage-sqljs"
import { NodeFS } from "./vfs-node"
import { NodeSearchProvider } from "./search-node"

// ── Config ─────────────────────────────────────────────────────────────────

const PROVIDER = process.env.PROVIDER ?? "anthropic"
const MODEL = process.env.MODEL ?? "claude-sonnet-4-20250514"
const API_KEY = process.env.API_KEY
const BASE_URL = process.env.BASE_URL
const PORT = parseInt(process.env.PORT ?? "3210", 10)
const PROJECT_DIR = path.resolve(process.argv[2] ?? process.cwd())

if (!API_KEY) {
  console.error("❌  Missing API_KEY environment variable")
  console.error("Usage: API_KEY=sk-xxx any-code-server [project-dir]")
  process.exit(1)
}

// ── Paths ──────────────────────────────────────────────────────────────────

function makePaths() {
  const dataPath = path.join(os.homedir(), ".any-code", "data")
  fs.mkdirSync(dataPath, { recursive: true })
  return dataPath
}



// ── Node.js ShellProvider ────────────────────────────────────────────────

class NodeShellProvider {
  platform = process.platform
  private shell: string

  constructor() {
    const s = process.env.SHELL
    const BLACKLIST = new Set(["fish", "nu"])
    if (s && !BLACKLIST.has(path.basename(s))) {
      this.shell = s
    } else {
      this.shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"
    }
  }

  spawn(command: string, opts: { cwd: string; env: Record<string, string | undefined> }) {
    return cpSpawn(command, {
      shell: this.shell,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }) as any
  }

  async kill(proc: any, opts?: { exited?: () => boolean }) {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return
    const SIGKILL_TIMEOUT_MS = 200
    try {
      process.kill(-pid, "SIGTERM")
      await new Promise(r => setTimeout(r, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) process.kill(-pid, "SIGKILL")
    } catch {
      proc.kill("SIGTERM")
      await new Promise(r => setTimeout(r, SIGKILL_TIMEOUT_MS))
      if (!opts?.exited?.()) proc.kill("SIGKILL")
    }
  }
}

// ── Node.js GitProvider ──────────────────────────────────────────────────

class NodeGitProvider {
  async run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
    return new Promise<{ exitCode: number; text(): string; stdout: Uint8Array; stderr: Uint8Array }>((resolve) => {
      execFile("git", args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer",
      }, (error: any, stdout: any, stderr: any) => {
        const stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "")
        const stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "")
        resolve({
          exitCode: error ? (error as any).code ?? 1 : 0,
          text: () => stdoutBuf.toString(),
          stdout: new Uint8Array(stdoutBuf),
          stderr: new Uint8Array(stderrBuf),
        })
      })
    })
  }
}

// ── Agent Bootstrap ────────────────────────────────────────────────────────

let agent: InstanceType<typeof CodeAgent>
let currentSessionId: string | null = null

async function initAgent() {
  const agentPaths = makePaths()

  const PROVIDER_ID = BASE_URL ? `${PROVIDER}-proxy` : PROVIDER

  agent = new CodeAgent({
    directory: PROJECT_DIR,
    fs: new NodeFS(),
    search: new NodeSearchProvider(),
    storage: new SqlJsStorage(),
    shell: new NodeShellProvider(),
    git: new NodeGitProvider(),
    dataPath: agentPaths,
    provider: {
      id: PROVIDER_ID,
      apiKey: API_KEY!,
      model: MODEL,
      ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
    },
    config: {
      model: `${PROVIDER_ID}/${MODEL}`,
      small_model: `${PROVIDER_ID}/${MODEL}`,
      provider: {
        [PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          ...(BASE_URL ? { api: BASE_URL } : {}),
          options: { apiKey: API_KEY },
          models: {
            [MODEL]: {
              name: MODEL,
              attachment: true,
              tool_call: true,
              temperature: true,
              reasoning: false,
              limit: { context: 200000, output: 32000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    },
  })
  await agent.init()
  console.log(`✅  Agent initialized (project: ${PROJECT_DIR})`)
}

// ── HTTP Server ────────────────────────────────────────────────────────────

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = ""
  for await (const chunk of req) body += chunk
  const { message, sessionId } = JSON.parse(body)

  if (!currentSessionId) {
    const session = await agent.createSession()
    currentSessionId = session.id
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })

  res.write(`data: ${JSON.stringify({ sessionId: currentSessionId })}\n\n`)

  try {
    for await (const event of agent.chat(currentSessionId, message)) {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`)
  }
  res.end()
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

  if (req.method === "POST" && req.url === "/api/chat") {
    handleChat(req, res).catch((err) => {
      console.error(err)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: err.message }))
    })
    return
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "Not found" }))
})

// ── Main ───────────────────────────────────────────────────────────────────

export async function startServer() {
  console.log("🚀  Starting any-code-server…")
  await initAgent()
  server.listen(PORT, () => {
    console.log(`🌐  http://localhost:${PORT}`)
    console.log(`📂  Project: ${PROJECT_DIR}`)
    console.log(`🤖  Provider: ${PROVIDER} / ${MODEL}`)
  })
}

export { CodeAgent, SqlJsStorage, NodeFS, NodeSearchProvider }
