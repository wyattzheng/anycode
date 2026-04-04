import fs from "fs"
import os from "os"
// @ts-expect-error — @lydell/node-pty has types but exports config doesn't expose them
import * as pty from "@lydell/node-pty"
import xtermHeadless from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"
import { WebSocket as WS } from "ws"
import type { TerminalProvider } from "@any-code/agent"

export interface TerminalServerRuntime {
  terminalProviders: Map<string, NodeTerminalProvider>
  getSession(id: string): { directory: string } | undefined
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "")
}

const MAX_BUFFER_LINES = 5000

class TerminalStateModel {
  private headless: InstanceType<typeof xtermHeadless.Terminal>
  private serializer: InstanceType<typeof SerializeAddon>
  private alive = false
  private wsClients = new Set<WS>()

  onInput: ((data: string) => void) | null = null
  onResize: ((cols: number, rows: number) => void) | null = null

  constructor() {
    console.log("🖥  [TermModel] created headless 80×24, scrollback=5000")
    this.headless = new xtermHeadless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.headless.loadAddon(this.serializer)
  }

  setAlive(alive: boolean): void {
    console.log(`🖥  [TermModel] setAlive: ${this.alive} → ${alive}, clients=${this.wsClients.size}`)
    this.alive = alive
    this.notify({ type: alive ? "terminal.ready" : "terminal.none" })
  }

  pushOutput(data: string): void {
    console.log(`🖥  [TermModel] pushOutput: ${data.length}b → broadcast to ${this.wsClients.size} clients`)
    this.headless.write(data)
    this.notify({ type: "terminal.output", data })
  }

  pushExited(exitCode: number): void {
    console.log(`🖥  [TermModel] exited: code=${exitCode}`)
    this.notify({ type: "terminal.exited", exitCode })
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) {
      console.log(`🖥  [TermModel] resize: headless → ${cols}×${rows}`)
      this.headless.resize(cols, rows)
    }
  }

  reset(): void {
    console.log("🖥  [TermModel] reset: disposing + recreating headless")
    this.headless.dispose()
    this.headless = new xtermHeadless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.headless.loadAddon(this.serializer)
  }

  private notify(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg)
    for (const ws of this.wsClients) {
      if (ws.readyState === WS.OPEN) ws.send(json)
    }
  }

  handleClient(ws: WS): void {
    ws.send(JSON.stringify({ type: this.alive ? "terminal.ready" : "terminal.none" }))
    const snapshot = this.serializer.serialize()
    console.log(`🖥  [TermModel] handleClient: alive=${this.alive}, clients=${this.wsClients.size}`)
    if (snapshot) {
      ws.send(JSON.stringify({ type: "terminal.sync", data: snapshot }))
    }
    console.log(`🖥  [TermModel] serialize() → ${snapshot?.length ?? 0} chars`)
    this.wsClients.add(ws)

    ws.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === "terminal.input") {
          this.onInput?.(msg.data)
        } else if (msg.type === "terminal.resize") {
          this.resize(msg.cols, msg.rows)
          this.onResize?.(msg.cols, msg.rows)
          const snap = this.serializer.serialize()
          if (snap) ws.send(JSON.stringify({ type: "terminal.sync", data: snap }))
        }
      } catch { /* ignore */ }
    })

    ws.on("close", () => {
      this.wsClients.delete(ws)
      console.log(`🖥  [TermModel] client left, remaining=${this.wsClients.size}`)
    })
  }
}

export class NodeTerminalProvider implements TerminalProvider {
  private proc: pty.IPty | null = null
  private lines: string[] = []
  private currentLine = ""
  readonly model: TerminalStateModel

  constructor(
    private readonly server: TerminalServerRuntime,
    private readonly sessionId: string,
  ) {
    this.model = new TerminalStateModel()
    this.model.onInput = (data) => this.proc?.write(data)
    this.model.onResize = (cols, rows) => this.resize(cols, rows)
  }

  exists(): boolean { return this.proc !== null }

  ensureRunning(reset?: boolean): void {
    if (this.proc && !reset) return
    if (this.proc) this.teardown()
    this.spawn()
  }

  spawn(): void {
    const session = this.server.getSession(this.sessionId)
    const cwd = session?.directory || os.homedir()
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/bash")

    if (!fs.existsSync(cwd)) {
      throw new Error(`Terminal cwd does not exist: ${cwd}`)
    }

    console.log(`🖥  Terminal creating: shell=${shell}, cwd=${cwd}, sessionId=${this.sessionId}`)
    this.lines = []
    this.currentLine = ""
    this.model.reset()

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v
    }
    env.PROMPT_EOL_MARK = ""
    env.CLICOLOR = "1"
    env.CLICOLOR_FORCE = "1"
    env.LSCOLORS = "GxFxCxDxBxegedabagaced"

    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env,
    })

    console.log(`🖥  Terminal created for session ${this.sessionId} (pid ${proc.pid}, cwd ${cwd})`)

    proc.onData((data: string) => {
      this.appendToBuffer(data)
      this.model.pushOutput(data)
    })

    proc.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`🖥  Terminal exited for session ${this.sessionId} (code ${exitCode})`)
      this.proc = null
      this.model.pushExited(exitCode)
      this.model.setAlive(false)
    })

    this.proc = proc
    this.model.setAlive(true)
  }

  teardown(): void {
    if (!this.proc) return
    console.log(`🖥  Terminal destroyed for session ${this.sessionId}`)
    this.proc.kill()
    this.proc = null
    this.lines = []
    this.currentLine = ""
    this.model.reset()
    this.model.setAlive(false)
  }

  write(data: string): void {
    this.ensureRunning()
    this.proc!.write(data)
  }

  read(lineCount: number): string {
    if (!this.proc) return "(no terminal)"
    const allLines = this.currentLine ? [...this.lines, this.currentLine] : [...this.lines]
    const start = Math.max(0, allLines.length - lineCount)
    return allLines.slice(start).join("\n")
  }

  resize(cols: number, rows: number): void {
    if (this.proc && cols > 0 && rows > 0) {
      this.proc.resize(cols, rows)
    }
  }

  private appendToBuffer(data: string) {
    const clean = stripAnsi(data)
    const lines = clean.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const segment = lines[i]
      if (i === 0) {
        this.handleCR(segment)
      } else {
        this.lines.push(this.currentLine)
        this.currentLine = ""
        this.handleCR(segment)
        if (this.lines.length > MAX_BUFFER_LINES) {
          this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES)
        }
      }
    }
  }

  private handleCR(segment: string) {
    const crParts = segment.split("\r")
    if (crParts.length === 1) {
      this.currentLine += segment
    } else {
      for (const part of crParts) {
        if (part === "") continue
        if (part.length >= this.currentLine.length) {
          this.currentLine = part
        } else {
          this.currentLine = part + this.currentLine.slice(part.length)
        }
      }
    }
  }
}

export function getOrCreateTerminalProvider(server: TerminalServerRuntime, sessionId: string): NodeTerminalProvider {
  let tp = server.terminalProviders.get(sessionId)
  if (!tp) {
    tp = new NodeTerminalProvider(server, sessionId)
    server.terminalProviders.set(sessionId, tp)
  }
  return tp
}

export function handleTerminalWs(server: TerminalServerRuntime, ws: WS, sessionId: string) {
  getOrCreateTerminalProvider(server, sessionId).model.handleClient(ws)
}
