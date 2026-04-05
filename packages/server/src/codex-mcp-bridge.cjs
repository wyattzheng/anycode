#!/usr/bin/env node
/**
 * Lightweight MCP server for Codex CLI integration.
 *
 * Spawned by the Codex CLI as a stdio MCP server.
 * Communicates with the parent AnyCode server via TCP (port from ANYCODE_MCP_PORT env).
 *
 * Exposes 3 custom tools matching the AnyCode extraTools:
 *   - set_user_watch_project
 *   - user_watch_terminal
 *   - set_preview_url
 *
 * Implements MCP protocol (JSON-RPC 2.0 over stdio) directly, no external deps.
 */

const readline = require("readline")
const net = require("net")

const TOOLS = [
  {
    name: "set_user_watch_project",
    description: "Let the user's frontend UI watch a project directory. This activates the file browser, diff viewer, and other project-related UI panels.\n\nThis is NOT required before you can start working. It only controls what the user sees.\n\nWhen to call:\n- After you create a new project\n- After you clone a repository\n- When the user asks to open or switch to a specific project\n\nIMPORTANT: If newly created, run `git init` first.\nThe directory must be an absolute path. Pass null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        directory: { type: ["string", "null"], description: "Absolute path to the project directory. Pass null to clear." },
      },
      required: ["directory"],
    },
  },
  {
    name: "user_watch_terminal",
    description: "Send input to the persistent shared terminal that the user can watch in the UI, optionally waiting and reading output.\n\nUse this for long-running or stateful shell sessions such as dev servers, REPLs, or interactive prompts. For simple one-shot commands, prefer the built-in shell.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Text to send to the terminal. Omit to just read output." },
        pressEnter: { type: "boolean", description: "Whether to press Enter after the input. Default: true." },
        reset: { type: "boolean", description: "If true, recreate the terminal before sending input." },
        waitMs: { type: "number", description: "Milliseconds to wait before reading output. Max 5000." },
        readLines: { type: "number", description: "Number of lines to read from the bottom after waiting. Default: 50." },
      },
    },
  },
  {
    name: "set_preview_url",
    description: "Set a preview URL for the user's Preview tab.\n\nCall after starting a dev server to let the user preview the app.",
    inputSchema: {
      type: "object",
      properties: {
        forwarded_local_url: { type: "string", description: "Full local URL (http:// or https://) to preview through the proxy." },
      },
      required: ["forwarded_local_url"],
    },
  },
]

// ── TCP communication with parent ──

const TCP_PORT = parseInt(process.env.ANYCODE_MCP_PORT || "0", 10)
let tcpClient = null
let tcpBuffer = ""
let tcpRequestId = 0
const pendingTcp = new Map()

function connectToParent() {
  if (!TCP_PORT) return

  tcpClient = net.createConnection({ port: TCP_PORT, host: "127.0.0.1" }, () => {
    // Connected
  })

  tcpClient.on("data", (chunk) => {
    tcpBuffer += chunk.toString()
    let newlineIdx
    while ((newlineIdx = tcpBuffer.indexOf("\n")) !== -1) {
      const line = tcpBuffer.slice(0, newlineIdx)
      tcpBuffer = tcpBuffer.slice(newlineIdx + 1)
      try {
        const msg = JSON.parse(line)
        if (msg.type === "tool_result" && pendingTcp.has(msg.id)) {
          const p = pendingTcp.get(msg.id)
          pendingTcp.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error))
          else p.resolve(msg.result)
        }
      } catch {}
    }
  })

  tcpClient.on("error", () => {})
  tcpClient.on("close", () => { tcpClient = null })
}

function callParent(toolName, args) {
  return new Promise((resolve, reject) => {
    if (!tcpClient) {
      reject(new Error("Not connected to parent"))
      return
    }
    const id = ++tcpRequestId
    pendingTcp.set(id, { resolve, reject })
    tcpClient.write(JSON.stringify({ type: "tool_call", id, toolName, args }) + "\n")
  })
}

// ── MCP stdio protocol ──

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

async function handleRequest(parsed) {
  const { id, method, params } = parsed

  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "anycode-tools", version: "1.0.0" },
      }})
      break

    case "notifications/initialized":
      break

    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
      break

    case "tools/call": {
      const toolName = params?.name
      const args = params?.arguments || {}
      try {
        const result = await callParent(toolName, args)
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: result?.output ?? JSON.stringify(result) }],
        }})
      } catch (err) {
        send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: err.message || String(err) }],
          isError: true,
        }})
      }
      break
    }

    default:
      if (id !== undefined) {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
      break
  }
}

rl.on("line", (line) => {
  let parsed
  try { parsed = JSON.parse(line) } catch { return }
  handleRequest(parsed).catch((err) => {
    if (parsed.id !== undefined) {
      send({ jsonrpc: "2.0", id: parsed.id, error: { code: -32603, message: err.message || String(err) } })
    }
  })
})

// Start
connectToParent()
