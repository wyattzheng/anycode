import path from "path"
import fsPromises from "fs/promises"
import { WebSocketServer, WebSocket as WS } from "ws"
import type { CodeAgent, TerminalProvider, PreviewProvider } from "@any-code/agent"
import { SetWorkingDirectoryTool } from "./tool-set-directory"
import { TerminalTool } from "./tool-terminal-write"
import { SetPreviewUrlTool } from "./tool-set-preview-url"
import { computeFileDiff, listDir, getGitChanges } from "./filesystem"
import { createChatAgent, type IChatAgent } from "./chat-agent"
import { getOrCreatePreviewProvider } from "./preview"
import { SessionStateModel, watchDirectory } from "./session-state"
import { getOrCreateTerminalProvider } from "./terminal"
import type { AnyCodeServer, ServerConfig } from "./index"

const NO_AGENT_TYPE = "noagent"
const text = (value: unknown) => typeof value === "string" ? value.trim() : ""

export interface ClientLike {
  readyState: number
  send(data: string): void
}

export interface SessionEntry {
  id: string
  chatAgent: IChatAgent
  agentType: string
  runtimeAgentType: string
  directory: string
  title: string
  createdAt: number
  state: SessionStateModel
}

interface NoAgentMessageRecord {
  role: "user" | "assistant"
  text: string
  createdAt: number
}

interface SessionAgentBinding {
  chatAgent: IChatAgent
  agentType: string
  runtimeAgentType: string
}

function getPreferredAgentType(agentType: string | undefined) {
  return text(agentType) || "anycode"
}

function getUsableResumeToken(agentType: string, token: string | undefined) {
  if (!token || agentType === NO_AGENT_TYPE) return undefined
  if (agentType === "claudecode" && token.startsWith("claude-")) return undefined
  if (agentType === "codex" && token.startsWith("codex-")) return undefined
  return token
}

function tryGetAgentSessionId(chatAgent: IChatAgent) {
  try {
    return chatAgent.sessionId || undefined
  } catch {
    return undefined
  }
}

async function destroyChatAgent(chatAgent: IChatAgent) {
  try { await chatAgent.abort() } catch { /* ignore */ }
  if (typeof chatAgent.destroy === "function") {
    try { await chatAgent.destroy() } catch { /* ignore */ }
  }
}

function createAgentConfig(server: AnyCodeServer, cfg: ServerConfig, directory: string, resumeToken?: string, terminal?: TerminalProvider, preview?: PreviewProvider) {
  const anyCodeSystemPrompt = `You are AnyCode, a voice-driven AI coding assistant running on the user's mobile device.

## Getting Started
When a user starts a new conversation without an active project, your first priority is to help them open or create a project:
- Ask what project they want to work on
- If they provide a path, use set_user_watch_project to open it
- If they want to create a new project, create it first (mkdir + git init), then call set_user_watch_project
- Do NOT start writing code until a project directory has been set via set_user_watch_project

## Guidelines
- Be concise — the user is on mobile, keep responses short
- Prefer action over explanation — execute rather than describe
- When running dev servers or long-lived processes, use the terminal tool and set_preview_url so the user can see results
`

  return {
    directory,
    fs: new server.NodeFS(),
    search: new server.NodeSearchProvider(),
    storage: server.sharedStorage,
    shell: new server.NodeShellProvider(),
    git: server.gitProvider,
    dataPath: server.makePaths(server.anycodeDir),
    ...(resumeToken ? { sessionId: resumeToken } : {}),
    ...(terminal ? { terminal } : {}),
    ...(preview ? { preview } : {}),
    tools: [SetWorkingDirectoryTool, TerminalTool, SetPreviewUrlTool],
    provider: {
      id: cfg.provider,
      apiKey: cfg.apiKey,
      model: cfg.model,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    },
    settings: cfg.userSettings,
    config: {},
    ...(cfg.agent !== "codex" ? { systemPrompt: anyCodeSystemPrompt } : {}),
  }
}

function createChatAgentConfig(server: AnyCodeServer, cfg: ServerConfig, directory: string, terminal?: TerminalProvider, preview?: PreviewProvider, resumeToken?: string) {
  return {
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    reasoningEffort: cfg.reasoningEffort,
    serviceTier: cfg.serviceTier,
    logger: server.consoleLogger,
    terminal,
    preview,
    sessionId: resumeToken,
    codeAgentOptions: createAgentConfig(server, cfg, directory, resumeToken, terminal, preview),
  }
}

export class SessionManager {
  constructor(private readonly server: AnyCodeServer) {}

  getSession(id: string) {
    return this.server.sessions.get(id)
  }

  getSessionClients(sessionId: string) {
    let set = this.server.sessionClients.get(sessionId)
    if (!set) {
      set = new Set()
      this.server.sessionClients.set(sessionId, set)
    }
    return set
  }

  scheduleStatePush(sessionId: string, delayMs = 300) {
    const existing = this.server.statePushTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.server.statePushTimers.delete(sessionId)
      this.getSession(sessionId)?.state.updateFileSystem()
    }, delayMs)
    this.server.statePushTimers.set(sessionId, timer)
  }

  private removeClient(sessionId: string, client: ClientLike) {
    const clients = this.server.sessionClients.get(sessionId)
    if (!clients) return
    clients.delete(client)
    if (clients.size === 0) this.server.sessionClients.delete(sessionId)
  }

  broadcast(sessionId: string, data: Record<string, unknown>) {
    const clients = this.server.sessionClients.get(sessionId)
    if (!clients || clients.size === 0) {
      if ((data as any).type?.startsWith("chat.")) {
        console.warn(`⚠  broadcast(${sessionId}): 0 clients, dropping ${(data as any).type}`)
      }
      return
    }
    const json = JSON.stringify(data)
    let sent = 0
    for (const client of clients) {
      if (client.readyState === WS.OPEN) {
        client.send(json)
        sent += 1
      }
    }
    if (sent === 0 && (data as any).type?.startsWith("chat.")) {
      console.warn(`⚠  broadcast(${sessionId}): ${clients.size} clients but 0 OPEN, dropping ${(data as any).type}`)
    }
  }

  broadcastAll(data: Record<string, unknown>) {
    const json = JSON.stringify(data)
    for (const clients of this.server.sessionClients.values()) {
      for (const client of clients) {
        if (client.readyState === WS.OPEN) client.send(json)
      }
    }
  }

  private createNoAgentStore(sessionId: string) {
    return {
      load: async (limit: number) => this.getPersistedNoAgentMessages(sessionId, limit),
      append: async (message: NoAgentMessageRecord) => {
        this.server.db.insert("user_session_message", {
          session_id: sessionId,
          role: message.role,
          text: message.text,
          time_created: message.createdAt,
        })
      },
    }
  }

  private getPersistedNoAgentMessages(sessionId: string, limit: number): NoAgentMessageRecord[] {
    const rows = this.server.db.findMany("user_session_message", {
      filter: { op: "eq", field: "session_id", value: sessionId },
      orderBy: [{ field: "id", direction: "desc" }],
      limit,
    })
    return rows.reverse().map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      text: typeof row.text === "string" ? row.text : "",
      createdAt: typeof row.time_created === "number" ? row.time_created : Date.now(),
    }))
  }

  private mergeSessionHistoryMessages(noAgentMessages: NoAgentMessageRecord[], runtimeMessages: any[], limit: number) {
    const persistedNoAgentMessages = noAgentMessages.map((message, index) => (
      message.role === "user"
        ? { id: `noagent-user-${index}`, role: "user", text: message.text, createdAt: message.createdAt }
        : { id: `noagent-assistant-${index}`, role: "assistant", parts: [{ type: "text", content: message.text }], createdAt: message.createdAt }
    ))

    return [...persistedNoAgentMessages, ...(Array.isArray(runtimeMessages) ? runtimeMessages : [])]
      .map((message, index) => ({
        ...message,
        id: typeof message?.id === "string" && message.id ? message.id : `merged-${index}`,
        createdAt: typeof message?.createdAt === "number" ? message.createdAt : index,
      }))
      .sort((a, b) => a.createdAt === b.createdAt ? String(a.id).localeCompare(String(b.id)) : a.createdAt - b.createdAt)
      .slice(-limit)
  }

  private async createSessionAgentBinding(
    sessionId: string,
    directory: string,
    terminal: TerminalProvider | undefined,
    preview: PreviewProvider | undefined,
    preferredAgentType: string,
    resumeToken?: string,
  ): Promise<SessionAgentBinding> {
    if (!this.server.cfg.apiKey) {
      const chatAgent = await createChatAgent(NO_AGENT_TYPE, {
        ...createChatAgentConfig(this.server, this.server.cfg, directory, terminal, preview),
        name: "No Agent",
        noAgentSessionId: sessionId,
        noAgentStore: this.createNoAgentStore(sessionId),
      } as any)
      await chatAgent.init()
      return { chatAgent, agentType: preferredAgentType, runtimeAgentType: NO_AGENT_TYPE }
    }

    const runtimeCfg = await this.server.accounts.resolveRuntimeConfig(this.server.cfg)
    const chatAgent = await createChatAgent(runtimeCfg.agent, createChatAgentConfig(this.server, runtimeCfg, directory, terminal, preview, resumeToken))
    await chatAgent.init()
    return { chatAgent, agentType: runtimeCfg.agent, runtimeAgentType: runtimeCfg.agent }
  }

  private bindSessionAgentEvents(entry: SessionEntry, chatAgent: IChatAgent) {
    const id = entry.id
    chatAgent.on("directory.set", (data: any) => {
      const dir = data.directory
      entry.directory = dir
      try { chatAgent.setWorkingDirectory(dir) } catch { /* ignore */ }
      this.server.db.update("user_session", { op: "eq", field: "session_id", value: id }, { directory: dir })
      console.log(`📂  Session ${id} directory set to: ${dir}`)
      entry.state.updateFileSystem(dir)
      watchDirectory(this.server, id, dir)
      this.broadcastAll({ type: "windows.updated" })
    })

    chatAgent.on("session.updated", (data: any) => {
      const title = data?.info?.title
      if (title && title !== entry.title) {
        entry.title = title
        this.broadcastAll({ type: "windows.updated" })
      }
    })

    chatAgent.on("cascade.created", (data: any) => {
      this.persistResumeTokenForWindow(id, entry.runtimeAgentType, data?.cascadeId)
    })
  }

  private registerSession(id: string, chatAgent: IChatAgent, directory: string, createdAt: number, agentType: string, runtimeAgentType: string) {
    const entry: SessionEntry = {
      id,
      chatAgent,
      agentType,
      runtimeAgentType,
      directory,
      createdAt,
      title: "",
      state: new SessionStateModel(this.server, id),
    }
    this.server.sessions.set(id, entry)
    entry.state.updateFileSystem(directory)
    this.bindSessionAgentEvents(entry, chatAgent)
    return entry
  }

  private persistResumeTokenForWindow(windowId: string, agentType: string, token: string | undefined) {
    const resumeToken = getUsableResumeToken(agentType, token)
    if (!resumeToken) return
    this.server.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { cascade_id: resumeToken })
    console.log(`🔗  Window ${windowId} resume token saved: ${resumeToken}`)
  }

  private persistAgentTypeForWindow(windowId: string, agentType: string) {
    this.server.db.update("user_session", { op: "eq", field: "session_id", value: windowId }, { agent_type: agentType })
  }

  async replaceSessionAgent(entry: SessionEntry, keepResumeToken: boolean) {
    const previousAgent = entry.chatAgent
    const row = this.server.db.findOne("user_session", { op: "eq", field: "session_id", value: entry.id }) as any
    const preferredAgentType = getPreferredAgentType(typeof row?.agent_type === "string" ? row.agent_type : entry.agentType)
    const storedResumeToken = getUsableResumeToken(preferredAgentType, typeof row?.cascade_id === "string" ? row.cascade_id : undefined)
    const liveResumeToken = getUsableResumeToken(entry.runtimeAgentType, tryGetAgentSessionId(previousAgent))
    const shouldKeepResumeToken = !this.server.cfg.apiKey || keepResumeToken
    const resumeToken = shouldKeepResumeToken ? (storedResumeToken || liveResumeToken) : undefined

    if (!shouldKeepResumeToken) {
      this.server.db.update("user_session", { op: "eq", field: "session_id", value: entry.id }, { cascade_id: "" })
    }

    const terminal = getOrCreateTerminalProvider(this.server, entry.id)
    const preview = getOrCreatePreviewProvider(this.server, this.server.cfg, entry.id)
    const next = await this.createSessionAgentBinding(entry.id, entry.directory, terminal, preview, preferredAgentType, resumeToken)

    entry.chatAgent = next.chatAgent
    entry.agentType = next.agentType
    entry.runtimeAgentType = next.runtimeAgentType
    this.persistAgentTypeForWindow(entry.id, entry.agentType)
    this.bindSessionAgentEvents(entry, next.chatAgent)

    if (entry.directory) {
      try { next.chatAgent.setWorkingDirectory(entry.directory) } catch { /* ignore */ }
      watchDirectory(this.server, entry.id, entry.directory)
    }

    this.persistResumeTokenForWindow(entry.id, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    await destroyChatAgent(previousAgent)
  }

  async applyAgentSwitchToSessions() {
    for (const entry of Array.from(this.server.sessions.values())) {
      this.server.sessionChatAbort.get(entry.id)?.()
      this.server.sessionChatAbort.delete(entry.id)
      entry.state.setChatBusy(false)
      await this.replaceSessionAgent(entry, !this.server.cfg.apiKey || entry.agentType === this.server.cfg.agent)
    }
  }

  async resumeSession(row: Record<string, unknown>) {
    const sessionId = row.session_id as string
    const cached = this.server.sessions.get(sessionId)
    if (cached) return cached

    const dir = (row.directory as string) || ""
    const preferredAgentType = getPreferredAgentType(typeof row.agent_type === "string" ? row.agent_type : this.server.cfg.agent)
    const resumeToken = getUsableResumeToken(preferredAgentType, (row.cascade_id as string) || undefined)
    console.log(`♻️  Resuming session ${sessionId}, resume_token=${resumeToken || "(none)"}, dir=${dir || "(none)"}`)
    const terminal = getOrCreateTerminalProvider(this.server, sessionId)
    const preview = getOrCreatePreviewProvider(this.server, this.server.cfg, sessionId)
    const next = await this.createSessionAgentBinding(sessionId, dir, terminal, preview, preferredAgentType, resumeToken)
    const entry = this.registerSession(sessionId, next.chatAgent, dir, row.time_created as number, next.agentType, next.runtimeAgentType)
    this.persistAgentTypeForWindow(sessionId, entry.agentType)
    if (dir) {
      try { next.chatAgent.setWorkingDirectory(dir) } catch { /* ignore */ }
      watchDirectory(this.server, sessionId, dir)
    }
    this.persistResumeTokenForWindow(sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    console.log(`♻️  Session ${sessionId} resumed`)
    return entry
  }

  async createNewWindow(isDefault = false) {
    const sessionId = crypto.randomUUID()
    const terminal = getOrCreateTerminalProvider(this.server, sessionId)
    const preview = getOrCreatePreviewProvider(this.server, this.server.cfg, sessionId)
    const next = await this.createSessionAgentBinding(sessionId, "", terminal, preview, getPreferredAgentType(this.server.cfg.agent))
    const now = Date.now()
    ; (terminal as any).sessionId = sessionId
    ; (preview as any).sessionId = sessionId
    const entry = this.registerSession(sessionId, next.chatAgent, "", now, next.agentType, next.runtimeAgentType)

    this.server.db.insert("user_session", {
      session_id: sessionId,
      directory: "",
      time_created: now,
      is_default: isDefault ? 1 : 0,
      cascade_id: "",
      agent_type: entry.agentType,
    })

    this.persistResumeTokenForWindow(sessionId, entry.runtimeAgentType, tryGetAgentSessionId(next.chatAgent))
    console.log(`✅  Window ${sessionId} created${isDefault ? " (default)" : ""}`)
    return entry
  }

  async getOrCreateSession() {
    const rows = this.server.db.findMany("user_session", {})
    const defaultRow = rows.find((row: any) => row.is_default === 1) || rows[0]
    if (defaultRow) {
      if (defaultRow.is_default !== 1) {
        this.server.db.update("user_session", { op: "eq", field: "session_id", value: defaultRow.session_id }, { is_default: 1 })
      }
      return this.resumeSession(defaultRow)
    }
    return this.createNewWindow(true)
  }

  async getAllWindows() {
    const rows = this.server.db.findMany("user_session", {})
    if (rows.length === 0) return [await this.createNewWindow(true)]
    const entries: SessionEntry[] = []
    for (const row of rows) entries.push(await this.resumeSession(row))
    return entries
  }

  async deleteWindow(sessionId: string) {
    const row = this.server.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
    if (!row || (row as any).is_default === 1) return false

    this.server.sessionChatAbort.get(sessionId)?.()
    this.server.sessionChatAbort.delete(sessionId)

    const statePushTimer = this.server.statePushTimers.get(sessionId)
    if (statePushTimer) {
      clearTimeout(statePushTimer)
      this.server.statePushTimers.delete(sessionId)
    }

    const watcher = this.server.dirWatchManagers.get(sessionId)
    if (watcher) {
      watcher.destroy()
      this.server.dirWatchManagers.delete(sessionId)
    }

    const session = this.server.sessions.get(sessionId)
    if (session) {
      this.server.sessions.delete(sessionId)
      await destroyChatAgent(session.chatAgent)
    }

    const terminal = this.server.terminalProviders.get(sessionId)
    if (terminal?.exists()) {
      try { terminal.teardown() } catch { /* ignore */ }
    }
    this.server.terminalProviders.delete(sessionId)
    this.server.previewProviders.delete(sessionId)
    this.server.sessionClients.delete(sessionId)

    if (this.server.previewSessionId === sessionId) {
      this.server.previewSessionId = null
      this.server.previewTarget = null
    }

    this.server.db.remove("user_session", { op: "eq", field: "session_id", value: sessionId })
    this.server.db.remove("user_session_message", { op: "eq", field: "session_id", value: sessionId })
    console.log(`🗑  Window ${sessionId} deleted`)
    return true
  }

  async getMessages(sessionId: string, limit = 30) {
    let session = this.getSession(sessionId)
    if (!session) {
      const row = this.server.db.findOne("user_session", { op: "eq", field: "session_id", value: sessionId })
      if (row) {
        try { session = await this.resumeSession(row as Record<string, unknown>) } catch { /* ignore */ }
      }
    }
    if (!session) return null

    const messages = await session.chatAgent.getSessionMessages({ limit })
    return session.runtimeAgentType === NO_AGENT_TYPE
      ? messages
      : this.mergeSessionHistoryMessages(this.getPersistedNoAgentMessages(session.id, limit), messages, limit)
  }

  async handleClientMessage(sessionId: string, client: ClientLike, msg: any) {
    if (msg.type === "ping") {
      client.send(JSON.stringify({ type: "pong" }))
      return
    }

    if (msg.type === "watch.dir") {
      const manager = this.server.dirWatchManagers.get(sessionId)
      if (manager && typeof msg.path === "string") manager.watchDir(msg.path)
      return
    }
    if (msg.type === "unwatch.dir") {
      const manager = this.server.dirWatchManagers.get(sessionId)
      if (manager && typeof msg.path === "string") manager.unwatchDir(msg.path)
      return
    }

    if (msg.type === "ls") {
      const session = this.getSession(sessionId)
      const dir = session?.directory
      if (!dir) return
      const target = path.resolve(dir, msg.path || "")
      if (!target.startsWith(path.resolve(dir))) return
      client.send(JSON.stringify({ type: "ls", path: msg.path || "", entries: await listDir(target) }))
      return
    }

    if (msg.type === "readFile") {
      const session = this.getSession(sessionId)
      const dir = session?.directory
      if (!dir) return
      const target = path.resolve(dir, msg.path || "")
      if (!target.startsWith(path.resolve(dir))) return
      try {
        const content = await fsPromises.readFile(target, "utf-8")
        client.send(JSON.stringify({ type: "fileContent", path: msg.path || "", content }))
      } catch {
        client.send(JSON.stringify({ type: "fileContent", path: msg.path || "", content: null, error: "读取失败" }))
      }
      return
    }

    if (msg.type === "chat.send") {
      const session = this.getSession(sessionId)
      if (!session) return
      const { message, fileContext } = msg
      const effectiveMessage = fileContext?.file && Array.isArray(fileContext.lines) && fileContext.lines.length > 0
        ? `[用户选中了文件 ${fileContext.file} 的 ${fileContext.lines[0] === fileContext.lines[fileContext.lines.length - 1] ? `L${fileContext.lines[0]}` : `L${fileContext.lines[0]}–${fileContext.lines[fileContext.lines.length - 1]}`} 行]\n\n${message}`
        : message
      const contextLabel = fileContext
        ? `[${fileContext.file} L${fileContext.lines[0]}–${fileContext.lines[fileContext.lines.length - 1]}]\n${message}`
        : message

      console.log(`💬  chat.send(${sessionId}): "${message.slice(0, 40)}${message.length > 40 ? "..." : ""}" → ${this.server.sessionClients.get(sessionId)?.size ?? 0} clients`)
      this.broadcast(sessionId, { type: "chat.userMessage", text: contextLabel })

      let aborted = false
      this.server.sessionChatAbort.set(sessionId, () => {
        aborted = true
        session.chatAgent.abort?.()
      })

      session.state.setChatBusy(true)
      try {
        for await (const event of session.chatAgent.chat(effectiveMessage)) {
          if (aborted) break
          this.broadcast(sessionId, { type: "chat.event", event })
        }
      } catch (error: any) {
        this.broadcast(sessionId, { type: "chat.event", event: { type: "error", error: error.message } })
      }

      this.server.sessionChatAbort.delete(sessionId)
      session.state.setChatBusy(false)
      session.chatAgent.getContext().then((ctx: any) => {
        if (ctx) session.state.setContext(ctx.contextUsed ?? 0, ctx.compactionThreshold ?? 0)
      }).catch(() => {})
      this.broadcast(sessionId, { type: "chat.done" })
      return
    }

    if (msg.type === "chat.stop") {
      this.server.sessionChatAbort.get(sessionId)?.()
    }
  }

  handleWebSocketConnection(ws: WS, req: any, port: number) {
    const url = new URL(req.url || "/", `http://localhost:${port}`)
    const sessionId = url.searchParams.get("sessionId")
    if (!sessionId || !this.getSession(sessionId)) {
      ws.close(4001, "Invalid session")
      return false
    }

    if (url.pathname === "/terminal") {
      getOrCreateTerminalProvider(this.server, sessionId).model.handleClient(ws)
      return true
    }

    const clients = this.getSessionClients(sessionId)
    clients.add(ws as ClientLike)
    console.log(`🔌  WS client connected to session ${sessionId} (${clients.size} total)`)

    const sessionModel = this.getSession(sessionId)?.state
    if (sessionModel) ws.send(JSON.stringify(sessionModel.toJSON()))

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        this.handleClientMessage(sessionId, ws as ClientLike, msg).catch(() => {})
      } catch { /* ignore */ }
    })

    ws.on("close", () => this.removeClient(sessionId, ws as ClientLike))
    return true
  }
}
