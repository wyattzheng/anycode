import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { ModelMessage } from "ai"
import PROMPT_ANTHROPIC_WITHOUT_TODO from "../../prompt/prompt/qwen.txt"
import PROMPT_TRINITY from "../../prompt/prompt/trinity.txt"
import type { VendorProvider } from "./types"

export const openAICompatibleVendor: VendorProvider = {
  id: "openai-compatible",
  npm: "@ai-sdk/openai-compatible",
  bundled: createOpenAICompatible,
  transform: {
    message(msgs, model) {
      if (!(typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field)) {
        return msgs
      }

      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [field]: reasoningText,
                },
              },
            }
          }

          return { ...msg, content: filteredContent }
        }
        return msg
      })
    },
  },
  prompt: {
    provider(model) {
      if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
      if (
        model.api.id.includes("gpt-5") ||
        model.api.id.includes("gpt-") ||
        model.api.id.includes("o1") ||
        model.api.id.includes("o3") ||
        model.api.id.includes("gemini-") ||
        model.api.id.includes("claude")
      ) {
        return undefined
      }
      return [PROMPT_ANTHROPIC_WITHOUT_TODO]
    },
  },
}
