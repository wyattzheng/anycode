import type { ModelProvider } from "./types"

export const liteLLMVendor: ModelProvider = {
  id: "litellm",
  matchesRuntime({ model, provider }) {
    return (
      provider.options?.["litellmProxy"] === true ||
      provider.id?.toLowerCase().includes("litellm") === true ||
      model.providerID?.toLowerCase().includes("litellm") === true ||
      model.api.id.toLowerCase().includes("litellm")
    )
  },
  llm: {
    needsNoopToolFallback() {
      return true
    },
  },
}
