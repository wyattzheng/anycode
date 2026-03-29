#!/usr/bin/env node
/**
 * MCP stdio bridge for @any-code/antigravity-agent.
 *
 * This script is spawned by the Go binary as an MCP server (stdio transport).
 * It reads tool definitions from ANYCODE_TOOLS_JSON env var and handles
 * tools/list + tools/call by forwarding to the parent process via TCP.
 *
 * Protocol: JSON-RPC 2.0 over stdio (MCP standard)
 *
 * Flow:
 *   1. Go binary spawns this script
 *   2. Binary sends initialize/tools/list/tools/call via stdin
 *   3. tools/list returns tool definitions from ANYCODE_TOOLS_JSON
 *   4. tools/call forwards to parent TCP server for execution
 *   5. Parent executes Tool.Info.execute() and returns result
 */
import { createConnection } from "node:net"

const TOOLS_JSON = process.env.ANYCODE_TOOLS_JSON || "[]"
const TCP_PORT = parseInt(process.env.ANYCODE_MCP_PORT || "0")

let tools = []
try {
  tools = JSON.parse(TOOLS_JSON)
} catch {}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line) handleMessage(line)
  }
})

function send(obj) {
  const s = JSON.stringify(obj)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`)
}

function handleMessage(raw) {
  // Handle Content-Length framing
  let jsonStr = raw
  if (raw.startsWith("Content-Length:")) {
    const parts = raw.split("\r\n\r\n")
    jsonStr = parts.slice(1).join("\r\n\r\n")
    if (!jsonStr) return // Wait for body
  }

  let msg
  try {
    msg = JSON.parse(jsonStr)
  } catch {
    return
  }

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
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema || { type: "object", properties: {} },
        })),
      },
    })
  } else if (msg.method === "tools/call") {
    const toolName = msg.params?.name
    const args = msg.params?.arguments || {}

    if (TCP_PORT > 0) {
      // Forward to parent TCP server for execution
      const conn = createConnection(TCP_PORT, "127.0.0.1", () => {
        conn.write(
          JSON.stringify({ type: "tool_call", id: msg.id, toolName, args }) +
            "\n",
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
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [{ type: "text", text: resp.error }],
                  isError: true,
                },
              })
            } else {
              send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  content: [
                    { type: "text", text: resp.result?.output || "" },
                  ],
                },
              })
            }
          } catch {}
          conn.end()
        }
      })
      conn.on("error", () => {
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
  }
}
