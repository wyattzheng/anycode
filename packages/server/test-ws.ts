import WebSocket from "ws"

const SESSION = "claude-1774204399246"
const ws = new WebSocket(`wss://test.anycoder.io:2223?sessionId=${SESSION}`, { rejectUnauthorized: false })

ws.on("open", () => {
  console.log("[WS] Connected\n")
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: "chat.send",
      message: 'Use the user_watch_terminal tool to send "echo hello" to the shared terminal visible in the user UI. Report the result of each tool call.'
    }))
    console.log("[WS] Sent chat.send\n")
  }, 500)
})

ws.on("message", (data: Buffer) => {
  const msg = JSON.parse(data.toString())

  if (msg.type === "chat.event") {
    const evt = msg.event
    if (evt?.type === "tool.start" || evt?.type === "tool.end") {
      console.log(`\n[TOOL ${evt.type}]`, JSON.stringify(evt).slice(0, 1000))
    } else if (evt?.type === "text" || evt?.type === "text.delta") {
      process.stdout.write(evt.text || evt.content || "")
    } else if (evt?.type === "error") {
      console.log(`\n[ERROR]`, JSON.stringify(evt))
    } else {
      console.log(`\n[EVT ${evt?.type}]`, JSON.stringify(evt).slice(0, 400))
    }
  } else if (msg.type === "chat.done") {
    console.log("\n\n[DONE]")
    setTimeout(() => ws.close(), 1000)
  } else if (msg.type === "state") {
    console.log("[STATE] ok")
  } else {
    console.log(`[MSG ${msg.type}]`, JSON.stringify(msg).slice(0, 300))
  }
})

ws.on("error", (err) => console.error("[ERR]", err.message))
ws.on("close", (code, reason) => {
  console.log(`[WS] Closed (${code}: ${reason})`)
  process.exit(0)
})

setTimeout(() => { console.log("[TIMEOUT]"); ws.close() }, 120000)
