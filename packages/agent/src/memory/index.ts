import type { AgentContext } from "../context"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"
import { EventEmitter } from "events"

import { MessageV2 } from "./message-v2"
import type { Provider } from "../provider/provider"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"

import { fn } from "../util/fn"
import { iife } from "../util/fn"
import { NotFoundError } from "../storage"

/**
 * MemoryService — manages message & part persistence + real-time event emission.
 *
 * Uses EventEmitter for self-contained event emission.
 * Events are forwarded to the bus at the integration layer (code-agent.ts).
 */
export class MemoryService extends EventEmitter {
  constructor(private context: AgentContext) {
    super()
  }

  async updateMessage(msg: any) {
    const time_created = msg.time.created
    const { id, sessionID, ...data } = msg
    this.context.db.upsert("message",
      { id, session_id: sessionID, time_created, data },
      ["id"],
      { data },
    )
    this.emit("message.updated", { info: msg })
    return msg
  }

  async removeMessage(input: any) {
    // CASCADE delete handles parts automatically
    this.context.db.remove("message",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.messageID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    this.emit("message.removed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
    })
  }

  async removePart(input: any) {
    this.context.db.remove("part",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.partID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    this.emit("message.part.removed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
    })
  }

  async updatePart(part: any) {
    const { id, messageID, sessionID, ...data } = part
    const time = Date.now()
    this.context.db.upsert("part",
      { id, message_id: messageID, session_id: sessionID, time_created: time, data },
      ["id"],
      { data },
    )
    this.emit("message.part.updated", { part: structuredClone(part) })
    return part
  }

  async updatePartDelta(input: any) {
    this.emit("message.part.delta", input)
  }

  async messages(input: { sessionID: any; limit?: number }) {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream(this.context, input.sessionID)) {
      if (input.limit && result.length >= input.limit) break
      result.push(msg)
    }
    result.reverse()
    return result
  }

  /**
   * Snapshot current message IDs for a session.
   * Call before ephemeral chat, then pass result to rollback() after.
   */
  snapshotMessages(sessionID: any): string[] {
    const rows = this.context.db.findMany("message", { op: "eq", field: "session_id", value: sessionID })
    return rows.map((r: any) => r.id)
  }

  /**
   * Remove messages created after the snapshot (i.e. not in the snapshot set).
   */
  async rollbackMessages(sessionID: any, snapshot: string[]) {
    const keep = new Set(snapshot)
    const rows = this.context.db.findMany("message", { op: "eq", field: "session_id", value: sessionID })
    for (const row of rows) {
      if (!keep.has(row.id)) {
        this.context.db.remove("message", {
          op: "and",
          conditions: [
            { op: "eq", field: "id", value: row.id },
            { op: "eq", field: "session_id", value: sessionID },
          ],
        })
      }
    }
  }
}

/**
 * Static utility functions (no context dependency).
 */
export namespace Memory {
  export const getUsage = fn(
    z.object({
      model: z.custom<Provider.Model>(),
      usage: z.custom<LanguageModelV2Usage>(),
      metadata: z.custom<ProviderMetadata>().optional(),
    }),
    (input) => {
      const safe = (value: number) => {
        if (!Number.isFinite(value)) return 0
        return value
      }
      const inputTokens = safe(input.usage.inputTokens ?? 0)
      const outputTokens = safe(input.usage.outputTokens ?? 0)
      const reasoningTokens = safe(input.usage.reasoningTokens ?? 0)

      const cacheReadInputTokens = safe(input.usage.cachedInputTokens ?? 0)
      const cacheWriteInputTokens = safe(
        (input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
          // @ts-expect-error
          input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
          0) as number,
      )

      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        if (
          input.model.api.npm === "@ai-sdk/anthropic" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock" ||
          input.model.api.npm === "@ai-sdk/google-vertex/anthropic"
        ) {
          return adjustedInputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens
        }
        return input.usage.totalTokens
      })

      const tokens = {
        total,
        input: adjustedInputTokens,
        output: outputTokens,
        reasoning: reasoningTokens,
        cache: {
          write: cacheWriteInputTokens,
          read: cacheReadInputTokens,
        },
      }

      const costInfo =
        input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
          ? input.model.cost.experimentalOver200K
          : input.model.cost
      return {
        cost: safe(
          new Decimal(0)
            .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
            .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
            .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )
}
