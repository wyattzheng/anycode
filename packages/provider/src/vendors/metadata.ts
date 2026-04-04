import type { VendorProvider } from "./types"

type VendorMetadata = Pick<VendorProvider, "id" | "getDefaultModel" | "getDefaultBaseUrl" | "getBrandVendor">

export const anthropicVendorMetadata = {
  id: "anthropic",
  getDefaultModel() {
    return "claude-opus-4-6"
  },
  getDefaultBaseUrl() {
    return "https://api.anthropic.com/v1"
  },
} satisfies VendorMetadata

export const googleVendorMetadata = {
  id: "google",
  getDefaultModel() {
    return "gemini-3.1-pro"
  },
  getDefaultBaseUrl() {
    return "https://generativelanguage.googleapis.com/v1beta"
  },
} satisfies VendorMetadata

export const openAIVendorMetadata = {
  id: "openai",
  getDefaultModel() {
    return "gpt-5.4"
  },
  getDefaultBaseUrl() {
    return "https://api.openai.com/v1"
  },
} satisfies VendorMetadata

export const antigravityVendorMetadata = {
  id: "antigravity",
  getDefaultModel() {
    return "gemini-3.1-pro"
  },
  getDefaultBaseUrl() {
    return "https://daily-cloudcode-pa.googleapis.com"
  },
  getBrandVendor() {
    return "google"
  },
} satisfies VendorMetadata

export const liteLLMVendorMetadata = {
  id: "litellm",
} satisfies VendorMetadata

export const githubCopilotVendorMetadata = {
  id: "github-copilot",
} satisfies VendorMetadata

const VENDOR_METADATA = [
  anthropicVendorMetadata,
  antigravityVendorMetadata,
  githubCopilotVendorMetadata,
  googleVendorMetadata,
  liteLLMVendorMetadata,
  openAIVendorMetadata,
] satisfies VendorMetadata[]

function normalizeVendorId(vendor: unknown) {
  return typeof vendor === "string" ? vendor.trim().toLowerCase() : ""
}

export function getVendorMetadata(vendor: unknown): VendorMetadata | undefined {
  const normalized = normalizeVendorId(vendor)
  if (!normalized) return undefined
  return VENDOR_METADATA.find((item) => item.id === normalized)
}

export function getVendorDefaultModel(vendor: unknown): string | undefined {
  return getVendorMetadata(vendor)?.getDefaultModel?.()
}

export function getVendorDefaultBaseUrl(vendor: unknown): string | undefined {
  return getVendorMetadata(vendor)?.getDefaultBaseUrl?.()
}

export function getVendorBrandVendor(vendor: unknown): string | undefined {
  const normalized = normalizeVendorId(vendor)
  return (getVendorMetadata(vendor)?.getBrandVendor?.() ?? normalized) || undefined
}
