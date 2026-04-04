import type { VendorProvider } from "./types"

export const githubCopilotVendor: VendorProvider = {
  id: "github-copilot",
  matchesRuntime({ model, provider }) {
    return provider.id?.includes("github-copilot") === true || model.providerID?.includes("github-copilot") === true
  },
  llm: {
    disableMaxOutputTokens() {
      return true
    },
  },
}
