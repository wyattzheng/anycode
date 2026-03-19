import { createOpenAI } from "@ai-sdk/openai"
import PROMPT_BEAST from "../../prompt/prompt/beast.txt"
import PROMPT_CODEX from "../../prompt/prompt/codex_header.txt"
import type { VendorProvider } from "./types"

export const openAIVendor: VendorProvider = {
  id: "openai",
  npm: "@ai-sdk/openai",
  bundled: createOpenAI,
  sdkKey: "openai",
  async customLoader() {
    return {
      autoload: false,
      async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
        // sdk.responses() is only available on @ai-sdk/openai, not on
        // @ai-sdk/openai-compatible. Fall back to languageModel() when
        // the Responses API helper is missing (e.g. third-party endpoints).
        if (typeof sdk.responses === "function") {
          return sdk.responses(modelID)
        }
        return sdk.languageModel(modelID)
      },
      options: {},
    }
  },
  patchRequest({ opts, model }) {
    if (opts.body && opts.method === "POST") {
      try {
        const body = JSON.parse(opts.body as string)
        const isAzure = model.providerID?.includes("azure")
        const keepIds = isAzure && body.store === true
        if (!keepIds && Array.isArray(body.input)) {
          for (const item of body.input) {
            if ("id" in item) delete item.id
          }
          opts.body = JSON.stringify(body)
        }
      } catch {
        // Ignore parse errors
      }
    }
  },
  transform: {
    options({ model, sessionID, providerOptions }) {
      const result: Record<string, any> = {}

      if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
        result["store"] = false
      }

      if (model.providerID === "openai" || providerOptions?.setCacheKey) {
        result["promptCacheKey"] = sessionID
      }

      if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
        if (!model.api.id.includes("gpt-5-pro")) {
          result["reasoningEffort"] = "high"
          result["reasoningSummary"] = "auto"
        }
        if (model.api.id.includes("gpt-5.") && !model.api.id.includes("codex") && !model.api.id.includes("-chat")) {
          result["textVerbosity"] = "low"
        }
      }

      return result
    },
    smallOptions(model) {
      if (!(model.providerID === "openai" || model.api.npm === "@ai-sdk/openai")) return {}
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.")) return { store: false, reasoningEffort: "low" }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    },
  },
  llm: {
    useInstructionPrompt({ provider, auth }) {
      return provider.id === "openai" && auth?.type === "oauth"
    },
    includeProviderSystemPrompt({ provider, auth }) {
      return !(provider.id === "openai" && auth?.type === "oauth")
    },
    disableMaxOutputTokens({ provider, auth }) {
      return provider.id === "openai" && auth?.type === "oauth"
    },
  },
  prompt: {
    provider(model) {
      if (model.api.id.includes("gpt-5")) return [PROMPT_CODEX]
      if (model.api.id.includes("gpt-") || model.api.id.includes("o1") || model.api.id.includes("o3")) {
        return [PROMPT_BEAST]
      }
      return undefined
    },
    instructions(model) {
      if (!model.api.id.includes("gpt-5")) return undefined
      return PROMPT_CODEX.trim()
    },
  },
}
