
import type { AgentContext } from "../context"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "./message-v2"
import { Provider, VendorRegistry } from "@any-code/provider"
import { LLMRunner } from "../llm-runner"
import PROMPT_COMPACTION from "../prompt/compaction.txt"

const COMPACTION_BUFFER = 20_000
const MAX_TOOL_OUTPUT_TOKENS = 40_000
const CHARS_PER_TOKEN = 4

function getLimits(model: Provider.Model, config: any) {
  const contextLimit = model.limit.context ?? 0
  const modelProvider = VendorRegistry.getModelProvider({ model })
  const reserved =
    config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, modelProvider.getMaxOutputTokens())
  const compactionThreshold = model.limit.input
    ? model.limit.input - reserved
    : contextLimit - modelProvider.getMaxOutputTokens()
  return { contextLimit, compactionThreshold }
}

function countInputTokens(tokens: MessageV2.Assistant["tokens"]) {
  return tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
}

function getLastStepTokens(context: AgentContext, sessionID: string) {
  const parts = context.db.findMany("part", {
    filter: { op: "eq", field: "session_id", value: sessionID },
    orderBy: [{ field: "id", direction: "desc" }],
  })
  for (const row of parts) {
    if (row.data?.type === "step-finish" && row.data.tokens) return row.data.tokens
  }
  return undefined
}

// ── Interface ─────────────────────────────────────────────────────────

export interface ICompactionService {
  truncateToolOutput(output: string): string
  isOverflow(input: { tokens: MessageV2.StepFinishPart["tokens"]; model: Provider.Model; context: AgentContext }): Promise<boolean>
  isOverflowForSession(context: AgentContext, sessionID: string, model: Provider.Model): Promise<boolean>
  getStatus(context: AgentContext, sessionID: string): Promise<{ contextUsed: number; contextLimit: number; compactionThreshold: number; compactions: number }>
  process(context: AgentContext, input: any): Promise<"continue" | "stop">
  create(context: AgentContext, input: any): Promise<void>
}

// ── CompactionService ─────────────────────────────────────────────────

export class CompactionService implements ICompactionService {
  truncateToolOutput(output: string): string {
    const maxChars = MAX_TOOL_OUTPUT_TOKENS * CHARS_PER_TOKEN
    if (output.length <= maxChars) return output
    return output.slice(0, maxChars) + "\n\n[TRUNCATED - Content exceeds " + MAX_TOOL_OUTPUT_TOKENS.toLocaleString() + " token limit]"
  }

  async isOverflow(input: { tokens: MessageV2.StepFinishPart["tokens"]; model: Provider.Model; context: AgentContext }) {
    if (input.context.config.compaction?.auto === false) return false
    const { contextLimit, compactionThreshold } = getLimits(input.model, input.context.config)
    if (contextLimit === 0) return false
    return countInputTokens(input.tokens) >= compactionThreshold
  }

  async isOverflowForSession(context: AgentContext, sessionID: string, model: Provider.Model) {
    const tokens = getLastStepTokens(context, sessionID)
    if (!tokens) return false
    return this.isOverflow({ tokens, model, context })
  }

  async getStatus(context: AgentContext, sessionID: string) {
    const msgs = await context.memory.messages({ sessionID: sessionID as any })

    let compactions = 0
    for (const msg of msgs) {
      if (msg.info.role === "assistant" && (msg.info as any).summary) compactions++
    }

    const tokens = getLastStepTokens(context, sessionID)
    const contextUsed = tokens
      ? (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
      : 0

    let contextLimit = 0
    let compactionThreshold = 0
    const lastUser = msgs.findLast(m => m.info.role === "user") as any
    if (lastUser?.info?.model) {
      try {
        const model = await context.provider.getModel(lastUser.info.model.providerID, lastUser.info.model.modelID)
        ;({ contextLimit, compactionThreshold } = getLimits(model, context.config))
      } catch { /* model not found */ }
    }

    return { contextUsed, contextLimit, compactionThreshold, compactions }
  }

  async process(context: AgentContext, input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
    context: AgentContext
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = { name: "compaction", mode: "primary" as const, prompt: PROMPT_COMPACTION, options: {} }
    const model = await context.provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await context.memory.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: input.context.directory,
        root: input.context.worktree,
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = LLMRunner.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
      context: input.context,
    })
    const compacting = { context: [] as string[], prompt: undefined as string | undefined }
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const result = await processor.process({
      user: userMessage,
      prompt: agent.prompt,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      context: input.context,
      messages: [
        ...MessageV2.toModelMessages(messages, model, { stripMedia: true }),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await context.memory.updateMessage(processor.message)
      return "stop" as const
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await context.memory.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await context.memory.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await context.memory.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await context.memory.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (processor.message.error) return "stop" as const
    return "continue" as const
  }

  async create(context: AgentContext, input: any) {
    const msg = await context.memory.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      model: input.model,
      sessionID: input.sessionID,
      agent: input.agent,
      time: {
        created: Date.now(),
      },
    })
    await context.memory.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: msg.sessionID,
      type: "compaction",
      auto: input.auto,
      overflow: input.overflow,
    })
  }
}

// Keep backward-compat alias
export { CompactionService as ContextCompaction }
