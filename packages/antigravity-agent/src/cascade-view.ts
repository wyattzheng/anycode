/**
 * CascadeView — Unified stream step processor.
 *
 * Processes StreamAgentStateUpdates frames:
 *   - Emits real-time events (thinking, text, tool, error)
 *   - Maintains internal steps state for message history snapshots
 *   - Handles auto-approve for WAITING steps
 *
 * Both chat() and getSessionMessages() use the same instance.
 */
import { EventEmitter } from "events"

export interface CascadeViewOptions {
  /** RPC call function: (method, body?) => Promise<json> */
  rpc: (method: string, body?: any) => Promise<any>
  /** Current cascade ID */
  cascadeId: string
}

export class CascadeView extends EventEmitter {
  // ─── State ───
  private steps = new Map<number, any>()             // stepIndex → latest step data
  private toolCallArgsCache = new Map<string, any>() // toolCallId → parsed args
  private processedIndices = new Set<number>()
  private lastText = ""
  private lastThinking = ""
  private hasEmittedThinkingStart = false
  private hasEmittedThinkingEnd = false
  private trajectoryId: string | null = null

  private rpc: (method: string, body?: any) => Promise<any>
  private _cascadeId: string

  constructor(opts: CascadeViewOptions) {
    super()
    this.rpc = opts.rpc
    this._cascadeId = opts.cascadeId
  }

  get cascadeId(): string { return this._cascadeId }

  /** Reset incremental state for a new chat turn (keeps history steps) */
  reset(cascadeId: string): void {
    this._cascadeId = cascadeId
    this.lastText = ""
    this.lastThinking = ""
    this.hasEmittedThinkingStart = false
    this.hasEmittedThinkingEnd = false
    this.processedIndices.clear()
    this.toolCallArgsCache.clear()
    this.trajectoryId = null
  }

  // ─── Feed data ───

  /** Process a raw stream frame JSON. Returns true if cascade is complete. */
  feedFrame(json: any): boolean {
    const update = json.update
    if (!update) return false

    // Process steps
    const stepsUpdate = update.mainTrajectoryUpdate?.stepsUpdate
    if (stepsUpdate?.steps) {
      const indices: number[] = stepsUpdate.indices || []
      const steps: any[] = stepsUpdate.steps || []
      for (let i = 0; i < steps.length; i++) {
        const stepIndex = indices[i] ?? i
        this.steps.set(stepIndex, steps[i])
        this.processStep(steps[i], stepIndex)
      }
    }

    // Resolve trajectoryId
    if (update.trajectoryId && !this.trajectoryId) {
      this.trajectoryId = update.trajectoryId
    }

    // Check completion
    if (update.status === "CASCADE_RUN_STATUS_IDLE") {
      if (stepsUpdate?.steps) {
        for (const step of stepsUpdate.steps) {
          if (step.type === "CORTEX_STEP_TYPE_CHECKPOINT" && step.status === "CORTEX_STEP_STATUS_DONE") {
            return true
          }
        }
      }
      if (update.executorMetadata?.terminationReason) {
        return true
      }
    }
    return false
  }

  // ─── Step processing (emits events) ───

  private processStep(step: any, stepIndex: number): void {
    // PLANNER_RESPONSE: thinking + text streaming
    if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      const pr = step.plannerResponse || {}
      const thinking = pr.thinking
      const text = pr.modifiedResponse || pr.response
      console.log(`[Stream] PLANNER step#${stepIndex} status=${step.status} thinking=${thinking?.length || 0} response=${text?.length || 0} keys=${Object.keys(pr).join(",")}`)

      if (step.status === "CORTEX_STEP_STATUS_DONE") {
        const { thinking: _t, modifiedResponse: _r, response: _r2, ...rest } = pr
        console.log(`[Stream] PLANNER DONE metadata: ${JSON.stringify(rest).slice(0, 1000)}`)
        // Cache tool call args for subsequent steps
        if (pr.toolCalls) {
          for (const tc of pr.toolCalls) {
            if (tc.id && tc.argumentsJson) {
              try { this.toolCallArgsCache.set(tc.id, JSON.parse(tc.argumentsJson)) } catch { }
            }
          }
        }
      }

      if (thinking && thinking !== this.lastThinking) {
        if (!this.hasEmittedThinkingStart) {
          this.hasEmittedThinkingStart = true
          this.emit("event", { type: "thinking.start" })
        }
        const delta = thinking.startsWith(this.lastThinking)
          ? thinking.slice(this.lastThinking.length) : thinking
        if (delta) this.emit("event", { type: "thinking.delta", thinkingContent: delta })
        this.lastThinking = thinking
      }

      if (text && text !== this.lastText) {
        if (this.hasEmittedThinkingStart && !this.hasEmittedThinkingEnd) {
          this.hasEmittedThinkingEnd = true
          // thinkingDuration is protobuf Duration string like "0.732477s"
          const durationStr = typeof pr.thinkingDuration === "string" ? pr.thinkingDuration : pr.thinkingDuration?.seconds || "0"
          const durationSec = parseFloat(String(durationStr).replace("s", "")) || 0
          this.emit("event", { type: "thinking.end", thinkingDuration: Math.round(durationSec * 1000) })
        }
        const delta = text.startsWith(this.lastText)
          ? text.slice(this.lastText.length) : text
        if (delta) this.emit("event", { type: "text.delta", content: delta })
        this.lastText = text
      }
      return
    }

    // Skip already-processed non-streaming steps
    if (this.processedIndices.has(stepIndex)) return
    if (step.status !== "CORTEX_STEP_STATUS_DONE" && step.status !== "CORTEX_STEP_STATUS_ERROR"
      && step.status !== "CORTEX_STEP_STATUS_WAITING") return
    this.processedIndices.add(stepIndex)

    console.log(`[Cascade] step#${stepIndex}: type=${step.type} status=${step.status}`)

    // Auto-approve WAITING steps
    if (step.status === "CORTEX_STEP_STATUS_WAITING") {
      this.autoApprove(step, stepIndex)
      this.processedIndices.delete(stepIndex)
      return
    }

    switch (step.type) {
      case "CORTEX_STEP_TYPE_MCP_TOOL": {
        const mcp = step.mcpTool
        if (mcp?.toolCall) {
          const mcpToolName = mcp.toolCall.name || "unknown"
          let parsedArgs = {}
          try { parsedArgs = JSON.parse(mcp.toolCall.argumentsJson || "{}") } catch { }
          this.emit("event", { type: "tool.start", toolCallId: mcp.toolCall.id || "", toolName: mcpToolName, toolArgs: parsedArgs })
          if (step.status === "CORTEX_STEP_STATUS_DONE") {
            this.emit("event", {
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
        const toolCallId = step.metadata?.toolCall?.id || step.stepId || String(step.stepNumber || "")
        // Resolve args: cached PLANNER toolCalls → metadata → step-specific field
        let toolArgs: any = this.toolCallArgsCache.get(step.metadata?.toolCall?.id) || {}
        const rawArgs = step.metadata?.toolCall?.argumentsJson
        if (rawArgs && rawArgs !== "{}" && rawArgs !== "") {
          try { toolArgs = JSON.parse(rawArgs) } catch { }
        } else if (Object.keys(toolArgs).length === 0) {
          toolArgs = step.runCommand || step.listDirectory || step.viewFile || step.writeFile || {}
        }
        this.emit("event", { type: "tool.start", toolCallId, toolName, toolArgs })
        if (step.status === "CORTEX_STEP_STATUS_DONE" || step.status === "CORTEX_STEP_STATUS_ERROR") {
          const output = step.error?.userErrorMessage || step.metadata?.toolCall?.result || step.listDirectory?.result || step.viewFile?.result || step.runCommand?.result || ""
          this.emit("event", {
            type: "tool.done", toolCallId,
            toolName, toolOutput: typeof output === "string" ? output : JSON.stringify(output), toolTitle: toolName, toolMetadata: {},
          })
        }
        break
      }

      case "CORTEX_STEP_TYPE_ERROR_MESSAGE": {
        const errMsg = step.errorMessage?.error?.userErrorMessage || step.errorMessage?.error?.shortError || "Unknown error"
        this.emit("event", { type: "error", error: errMsg })
        break
      }

      case "CORTEX_STEP_TYPE_SEARCH_WEB": {
        console.log(`[Stream] SEARCH_WEB data: ${JSON.stringify(step).slice(0, 800)}`)
        const searchData = step.searchWeb || step.webSearch || {}
        const query = searchData.query || searchData.searchQuery || ""
        this.emit("event", { type: "tool.start", toolCallId: step.stepId || String(stepIndex), toolName: "search_web", toolArgs: { query } })
        if (step.status === "CORTEX_STEP_STATUS_DONE") {
          const results = searchData.results || searchData.searchResults || []
          this.emit("event", {
            type: "tool.done", toolCallId: step.stepId || String(stepIndex),
            toolName: "search_web", toolOutput: typeof results === "string" ? results : JSON.stringify(results),
            toolTitle: `Search: ${query || "web"}`, toolMetadata: {},
          })
        }
        break
      }

      case "CORTEX_STEP_TYPE_CODE_ACTION": {
        const codeAction = step.codeAction || step.metadata?.toolCall || {}
        const toolCallId = step.metadata?.toolCall?.id || step.stepId || String(stepIndex)
        let toolArgs: any = this.toolCallArgsCache.get(step.metadata?.toolCall?.id) || codeAction
        if (codeAction.argumentsJson && codeAction.argumentsJson !== "{}") {
          try { toolArgs = JSON.parse(codeAction.argumentsJson) } catch { }
        }
        this.emit("event", { type: "tool.start", toolCallId, toolName: "code_action", toolArgs })
        if (step.status === "CORTEX_STEP_STATUS_DONE") {
          this.emit("event", {
            type: "tool.done", toolCallId,
            toolName: "code_action", toolOutput: codeAction.result || "", toolTitle: "Code Action", toolMetadata: {},
          })
        }
        break
      }

      default:
        if (!["CORTEX_STEP_TYPE_CHECKPOINT", "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE",
          "CORTEX_STEP_TYPE_USER_INPUT", "CORTEX_STEP_TYPE_CONVERSATION_HISTORY",
          "CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS"].includes(step.type)) {
          console.log(`[Cascade] unhandled step type: ${step.type}`, JSON.stringify(step).slice(0, 200))
        }
        break
    }
  }

  // ─── Auto‑approve ───

  private async autoApprove(step: any, stepIndex: number): Promise<void> {
    const stepIdx = step.stepNumber ?? step.stepIndex ?? stepIndex
    console.log(`[Cascade] ⚡ Auto-approving WAITING step#${stepIdx} (${step.type})`)

    if (!this.trajectoryId) {
      try {
        const trajRes = await this.rpc("GetCascadeTrajectory", { cascadeId: this._cascadeId })
        this.trajectoryId = trajRes.trajectory?.trajectoryId || null
      } catch { }
    }

    const tid = this.trajectoryId || this._cascadeId
    const interaction: any = { trajectoryId: tid, stepIndex: stepIdx }

    const isFileTool = ["CORTEX_STEP_TYPE_LIST_DIRECTORY", "CORTEX_STEP_TYPE_VIEW_FILE",
      "CORTEX_STEP_TYPE_CODE_ACTION", "CORTEX_STEP_TYPE_CREATE_FILE"].includes(step.type)

    if (isFileTool) {
      let absPath = ""
      try {
        const args = JSON.parse(step.metadata?.toolCall?.argumentsJson || step.toolCall?.argumentsJson || "{}")
        absPath = args.DirectoryPath || args.AbsolutePath || args.TargetFile || args.path || ""
      } catch { }
      interaction.filePermission = { allow: true, scope: 2, absolutePathUri: absPath ? `file://${absPath}` : "" }
    } else if (step.type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
      const toolCallId = step.metadata?.toolCall?.id || ""
      const cachedArgs = this.toolCallArgsCache.get(toolCallId) || {}
      const cmdLine = cachedArgs.CommandLine || cachedArgs.commandLine || cachedArgs.command || ""
      interaction.runCommand = {
        confirm: true,
        proposedCommandLine: cmdLine,
        submittedCommandLine: cmdLine,
      }
    } else {
      interaction.codeAction = {}
    }

    console.log(`[Cascade] Auto-approve payload: ${JSON.stringify({ cascadeId: this._cascadeId, interaction })}`)
    try {
      const res = await this.rpc("HandleCascadeUserInteraction", { cascadeId: this._cascadeId, interaction })
      console.log(`[Cascade] Auto-approve response: ${JSON.stringify(res).slice(0, 300)}`)
    } catch (e: any) {
      console.log(`[Cascade] Auto-approve ERROR: ${e.message}`)
    }
  }

  // ─── Message snapshot ───

  /** Build ChatMessage[] from internal steps state */
  getMessages(limit = 50): any[] {
    const messages: any[] = []
    let currentAssistantParts: any[] = []
    let currentAssistantText = ""
    let currentThinking = ""
    let hasAssistantContent = false

    // Sort by stepIndex
    const sortedEntries = [...this.steps.entries()].sort((a, b) => a[0] - b[0])

    for (const [idx, step] of sortedEntries) {
      if (step.type === "CORTEX_STEP_TYPE_USER_INPUT") {
        // Flush previous assistant message
        if (hasAssistantContent) {
          messages.push({
            id: `assistant-${this._cascadeId}-${idx}`,
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
            id: `user-${this._cascadeId}-${idx}`,
            role: "user",
            createdAt: new Date(step.metadata?.createdAt || 0).getTime(),
            text: userText,
          })
        }
      } else if (step.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
        hasAssistantContent = true
        if (step.plannerResponse?.thinking) currentThinking = step.plannerResponse.thinking
        const text = step.plannerResponse?.modifiedResponse || step.plannerResponse?.response
        if (text) currentAssistantText = text
      } else if (step.type === "CORTEX_STEP_TYPE_MCP_TOOL") {
        hasAssistantContent = true
        const toolName = step.mcpTool?.toolCall?.name || "unknown"
        currentAssistantParts.push({ type: "tool", tool: toolName, content: "completed" })
      } else if (step.type === "CORTEX_STEP_TYPE_SEARCH_WEB") {
        hasAssistantContent = true
        currentAssistantParts.push({ type: "tool", tool: "search_web", content: "completed" })
      } else if (step.type === "CORTEX_STEP_TYPE_CODE_ACTION") {
        hasAssistantContent = true
        currentAssistantParts.push({ type: "tool", tool: "code_action", content: "completed" })
      } else if ([
        "CORTEX_STEP_TYPE_LIST_DIRECTORY", "CORTEX_STEP_TYPE_VIEW_FILE",
        "CORTEX_STEP_TYPE_RUN_COMMAND", "CORTEX_STEP_TYPE_WRITE_FILE",
        "CORTEX_STEP_TYPE_GREP", "CORTEX_STEP_TYPE_FIND",
        "CORTEX_STEP_TYPE_CREATE_FILE",
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
}
