import type { VendorProvider } from "./types"

export const liteLLMVendor: VendorProvider = {
  id: "litellm",
  npm: "@ai-sdk/openai-compatible",
  bundled: () => {
    throw new Error("liteLLMVendor does not provide a bundled SDK")
  },
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
