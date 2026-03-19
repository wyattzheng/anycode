import type { VendorProvider } from "./types"

export const githubCopilotVendor: VendorProvider = {
  id: "github-copilot",
  npm: "@ai-sdk/openai-compatible",
  bundled: () => {
    throw new Error("githubCopilotVendor does not provide a bundled SDK")
  },
  matchesRuntime({ model, provider }) {
    return provider.id?.includes("github-copilot") === true || model.providerID?.includes("github-copilot") === true
  },
  llm: {
    disableMaxOutputTokens() {
      return true
    },
  },
}
