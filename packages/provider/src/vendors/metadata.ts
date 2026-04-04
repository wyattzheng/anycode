import type { VendorProvider } from "./types"

export interface VendorOAuthUiConfig {
  buttonLabel: string
  buttonLabelFilled: string
  pendingLabel: string
  helperText: string
}

type VendorMetadata = Pick<VendorProvider, "id" | "getDefaultModel" | "getDefaultBaseUrl" | "getBrandVendor"> & {
  getOAuthUi?: () => VendorOAuthUiConfig | undefined
}

export const antigravityVendorOAuthUi = {
  buttonLabel: "Google OAuth 登录",
  buttonLabelFilled: "重新 Google OAuth 登录",
  pendingLabel: "等待 Google 授权…",
  helperText: "登录成功后会自动把 OAuth 凭证填入 API_KEY。",
} satisfies VendorOAuthUiConfig

export const openAIVendorOAuthUi = {
  buttonLabel: "ChatGPT OAuth 登录",
  buttonLabelFilled: "重新 ChatGPT OAuth 登录",
  pendingLabel: "等待 ChatGPT 授权…",
  helperText: "授权完成后，把回调地址粘贴到 API_KEY。",
} satisfies VendorOAuthUiConfig

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
  getOAuthUi() {
    return openAIVendorOAuthUi
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
  getOAuthUi() {
    return antigravityVendorOAuthUi
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

export function getVendorOAuthUi(vendor: unknown): VendorOAuthUiConfig | undefined {
  return getVendorMetadata(vendor)?.getOAuthUi?.()
}
