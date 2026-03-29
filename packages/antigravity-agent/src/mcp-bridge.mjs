#!/usr/bin/env node
/**
 * MCP stdio bridge for @any-code/antigravity-agent.
 *
 * This script is spawned by the Go binary as an MCP server (stdio transport).
 * It reads tool definitions from ANYCODE_TOOLS_JSON env var and handles
 * tools/list + tools/call by forwarding to the parent process via TCP.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP standard)
 * Supports BOTH Content-Length framing AND bare JSON lines.
 */
import { createConnection } from "node:net"

const TOOLS_JSON = process.env.ANYCODE_TOOLS_JSON || "[]"
const TCP_PORT = parseInt(process.env.ANYCODE_MCP_PORT || "0")
const DEBUG = process.env.ANYCODE_MCP_DEBUG === "1"

let tools = []
try {
  tools = JSON.parse(TOOLS_JSON)
} catch {}

function log(...args) {
  if (DEBUG) process.stderr.write(`[mcp-bridge] ${args.join(" ")}\n`)
}

log(`Started. ${tools.length} tools, TCP port ${TCP_PORT}`)

// --- Stdin reading: handle both Content-Length framing and bare JSON lines ---

let buf = ""
let contentLength = -1

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  processBuffer()
})

function processBuffer() {
  while (buf.length > 0) {
    // Try Content-Length framing first
    if (contentLength === -1) {
      const headerEnd = buf.indexOf("\r\n\r\n")
      if (headerEnd !== -1) {
        const header = buf.slice(0, headerEnd)
        const clMatch = header.match(/Content-Length:\s*(\d+)/i)
        if (clMatch) {
          contentLength = parseInt(clMatch[1])
          buf = buf.slice(headerEnd + 4)
          continue
        }
      }
    }

    // If we have a pending Content-Length, wait for full body
    if (contentLength >= 0) {
      if (buf.length < contentLength) return // need more data
      const body = buf.slice(0, contentLength)
      buf = buf.slice(contentLength)
      contentLength = -1
      tryHandleJson(body)
      continue
    }

    // Fallback: try bare JSON line delimited by \n
    const nlIdx = buf.indexOf("\n")
    if (nlIdx === -1) return // need more data
    const line = buf.slice(0, nlIdx).trim()
    buf = buf.slice(nlIdx + 1)
    if (line) tryHandleJson(line)
  }
}

function tryHandleJson(str) {
  try {
    const msg = JSON.parse(str)
    log(`← ${msg.method || "response"} id=${msg.id}`)
    handleMessage(msg)
  } catch (e) {
    log(`Parse error: ${e.message}, input: ${str.slice(0, 200)}`)
  }
}

// --- Message sending ---

function send(obj) {
  const s = JSON.stringify(obj)
  const header = `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n`
  process.stdout.write(header + s)
  log(`→ response id=${obj.id}`)
}

// --- Message handling ---

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "anycode-tools", version: "1.0.0" },
      },
    })
  } else if (msg.method === "notifications/initialized") {
    // Notification, no response needed
  } else if (msg.method === "tools/list") {
    const toolList = tools.map((t) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }))
    log(`tools/list → ${toolList.length} tools: ${toolList.map(t => t.name).join(", ")}`)
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: toolList },
    })
  } else if (msg.method === "tools/call") {
    const toolName = msg.params?.name
    const args = msg.params?.arguments || {}
    log(`tools/call → ${toolName}(${JSON.stringify(args).slice(0, 200)})`)

    if (TCP_PORT > 0) {
      const conn = createConnection(TCP_PORT, "127.0.0.1", () => {
        conn.write(
          JSON.stringify({ type: "tool_call", id: msg.id, toolName, args }) + "\n",
        )
      })
      let respBuf = ""
      conn.on("data", (chunk) => {
        respBuf += chunk.toString()
        let i
        while ((i = respBuf.indexOf("\n")) !== -1) {
          const line = respBuf.slice(0, i)
          respBuf = respBuf.slice(i + 1)
          try {
            const resp = JSON.parse(line)
            if (resp.error) {
              log(`tools/call error: ${resp.error}`)
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: resp.error }],
                  isError: true,
                },
              })
            } else {
              const output = resp.result?.output || ""
              log(`tools/call result: ${output.slice(0, 100)}`)
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: output }],
                },
              })
            }
          } catch {}
          conn.end()
        }
      })
      conn.on("error", (err) => {
        log(`TCP connection error: ${err.message}`)
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: "MCP bridge connection error" }],
            isError: true,
          },
        })
      })
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: `Tool ${toolName} not available (no bridge)` }],
          isError: true,
        },
      })
    }
  } else {
    log(`Unknown method: ${msg.method}`)
    if (msg.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      })
    }
  }
}
