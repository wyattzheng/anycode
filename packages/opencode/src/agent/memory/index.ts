import type { AgentContext } from "@/agent/context"
import { Bus } from "@/agent/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata } from "ai"

import { SessionID, MessageID, PartID } from "@/agent/session/schema"
import { MessageV2 } from "@/agent/memory/message-v2"
import type { Provider } from "@/agent/provider/provider"
import type { LanguageModelV2Usage } from "@ai-sdk/provider"

import { fn } from "@/util/fn"
import { iife } from "@/util/iife"
import { NotFoundError } from "@/storage"

export namespace Memory {
  export async function updateMessage(context: AgentContext, msg: any) {
    const time_created = msg.time.created
    const { id, sessionID, ...data } = msg
    context.db.upsert("message",
      { id, session_id: sessionID, time_created, data },
      ["id"],
      { data },
    )
    Bus.publish(undefined, MessageV2.Event.Updated, {
      info: msg,
    })
    return msg
  }

  export async function removeMessage(context: AgentContext, input: any) {
    // CASCADE delete handles parts automatically
    context.db.remove("message",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.messageID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    Bus.publish(undefined, MessageV2.Event.Removed, {
      sessionID: input.sessionID,
      messageID: input.messageID,
    })
  }

  export async function removePart(context: AgentContext, input: any) {
    context.db.remove("part",
      { op: "and", conditions: [{ op: "eq", field: "id", value: input.partID }, { op: "eq", field: "session_id", value: input.sessionID }] },
    )
    Bus.publish(undefined, MessageV2.Event.PartRemoved, {
      sessionID: input.sessionID,
      messageID: input.messageID,
      partID: input.partID,
    })
  }

  export async function updatePart(context: AgentContext, part: any) {
    const { id, messageID, sessionID, ...data } = part
    const time = Date.now()
    context.db.upsert("part",
      { id, message_id: messageID, session_id: sessionID, time_created: time, data },
      ["id"],
      { data },
    )
    Bus.publish(undefined, MessageV2.Event.PartUpdated, {
      part: structuredClone(part),
    })
    return part
  }

  export const updatePartDelta = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      field: z.string(),
      delta: z.string(),
    }),
    async (input) => {
      Bus.publish(undefined, MessageV2.Event.PartDelta, input)
    },
  )

  export async function messages(context: AgentContext, input: { sessionID: any; limit?: number }) {
    const result = [] as MessageV2.WithParts[]
    for await (const msg of MessageV2.stream(context, input.sessionID)) {
      if (input.limit && result.length >= input.limit) break
      result.push(msg)
    }
    result.reverse()
    return result
  }

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

      // OpenRouter provides inputTokens as the total count of input tokens (including cached).
      // AFAIK other providers (OpenRouter/OpenAI/Gemini etc.) do it the same way e.g. vercel/ai#8794 (comment)
      // Anthropic does it differently though - inputTokens doesn't include cached tokens.
      // It looks like OpenCode's cost calculation assumes all providers return inputTokens the same way Anthropic does (I'm guessing getUsage logic was originally implemented with anthropic), so it's causing incorrect cost calculation for OpenRouter and others.
      const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
      const adjustedInputTokens = safe(
        excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
      )

      const total = iife(() => {
        // Anthropic doesn't provide total_tokens, also ai sdk will vastly undercount if we
        // don't compute from components
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
            // TODO: update models.dev to have better pricing model, for now:
            // charge reasoning tokens at the same rate as output tokens
            .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
            .toNumber(),
        ),
        tokens,
      }
    },
  )
}
