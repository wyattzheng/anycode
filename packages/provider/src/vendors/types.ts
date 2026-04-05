import type { ProviderContext } from "../context"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ModelMessage, Provider as SDK } from "ai"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "../provider"

export type ProviderSDKFactory = (options: any) => SDK

export type ProviderModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>

export type ProviderVarsLoader = (options: Record<string, any>) => Record<string, string>

export interface ProviderLoaderResult {
  autoload: boolean
  getModel?: ProviderModelLoader
  vars?: ProviderVarsLoader
  options?: Record<string, any>
}

export interface ProviderInfoLike {
  id?: string
  key?: string
  options: Record<string, any>
}

export interface ProviderModelLike {
  providerID?: string
  api: {
    id: string
    npm: string
    url: string
  }
}

export interface ProviderRequestPatchInput {
  opts: Record<string, any>
  model: ProviderModelLike
  provider: ProviderInfoLike
}

export interface ProviderTransformInput {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
}

export interface ProviderRuntimeInput {
  model: Provider.Model
  provider: ProviderInfoLike
  auth?: {
    type?: string
  } | null
}

export interface VendorApiKeyResolveInput {
  apiKey: string
  agent?: string
  oauth?: VendorOAuthState | null
}

export interface VendorApiKeyResolveResult {
  apiKey: string
  persistedApiKey?: string
  persistedOAuth?: VendorOAuthState | null
}

export interface VendorOAuthState {
  provider: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  expiresAt?: string
  clientId?: string
  scope?: string
  updatedAt?: string
}

export interface VendorQuotaWindow {
  usedPercent?: number
  windowMinutes?: number
  resetAfterSeconds?: number
  resetAt?: string
}

export interface VendorQuotaCredits {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: number | null
}

export interface VendorQuotaResult {
  updatedAt?: string
  planType?: string
  primary?: VendorQuotaWindow
  secondary?: VendorQuotaWindow
  credits?: VendorQuotaCredits | null
}

export interface VendorQuotaInput {
  apiKey: string
  agent?: string
  model?: string
  baseUrl?: string
  oauth?: VendorOAuthState | null
}

export interface VendorTransform {
  message?: (msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) => ModelMessage[]
  options?: (input: ProviderTransformInput) => Record<string, any>
  smallOptions?: (model: Provider.Model) => Record<string, any>
  temperature?: (model: Provider.Model) => number | undefined
  topK?: (model: Provider.Model) => number | undefined
  schema?: (model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7) => JSONSchema7
}

export interface VendorPrompt {
  provider?: (model: Provider.Model) => string[] | undefined
  instructions?: (model: Provider.Model) => string | undefined
}

export interface VendorLLM {
  useInstructionPrompt?: (input: ProviderRuntimeInput) => boolean
  includeProviderSystemPrompt?: (input: ProviderRuntimeInput) => boolean
  disableMaxOutputTokens?: (input: ProviderRuntimeInput) => boolean
  needsNoopToolFallback?: (input: ProviderRuntimeInput) => boolean
}

export interface VendorOAuthStartInput {
  redirectUri: string
  state: string
}

export interface VendorOAuthStartResult {
  authUrl: string
  state?: string
  redirectUri?: string
  captureMode?: "callback" | "manual"
  exchangeData?: Record<string, string>
}

export interface VendorOAuthExchangeInput {
  code: string
  state?: string
  redirectUri: string
  exchangeData?: Record<string, string>
}

export interface VendorOAuthExchangeResult {
  apiKey: string
  oauth?: VendorOAuthState | null
}

export interface VendorOAuth {
  start(input: VendorOAuthStartInput): VendorOAuthStartResult
  exchangeCode(input: VendorOAuthExchangeInput): Promise<VendorOAuthExchangeResult>
}

export interface VendorProvider {
  id: string
  getDefaultModel?: () => string | undefined
  getDefaultBaseUrl?: () => string | undefined
  getBrandVendor?: () => string | undefined
  npms?: string[]
  bundled?: Partial<Record<string, ProviderSDKFactory>>
  sdkKeys?: Partial<Record<string, string>>
  matchesRuntime?: (input: ProviderRuntimeInput) => boolean
  customLoader?: (context: ProviderContext, provider: ProviderInfoLike) => Promise<ProviderLoaderResult>
  patchRequest?: (input: ProviderRequestPatchInput) => void
  transform?: VendorTransform
  llm?: VendorLLM
  prompt?: VendorPrompt
  oauth?: VendorOAuth
  resolveApiKey?: (input: VendorApiKeyResolveInput) => Promise<VendorApiKeyResolveResult>
  getQuota?: (input: VendorQuotaInput) => Promise<VendorQuotaResult | null>
}

export interface VendorProviderAccessor {
  all(): VendorProvider[]
  getDefaultModel(): string | undefined
  getDefaultBaseUrl(): string | undefined
  getBrandVendor(): string | undefined
  getBundledProvider(): ProviderSDKFactory | undefined
  getCustomLoaders(): Record<string, (context: ProviderContext, provider: ProviderInfoLike) => Promise<ProviderLoaderResult>>
  getOAuth(): VendorOAuth | undefined
  resolveApiKey(input: VendorApiKeyResolveInput): Promise<VendorApiKeyResolveResult>
  getQuota(input: VendorQuotaInput): Promise<VendorQuotaResult | null>
  getOptionsKey(): string | undefined
  applyRequestPatch(patchInput: Omit<ProviderRequestPatchInput, "model"> & { model?: ProviderModelLike }): void
  applyMessageTransforms(msgs: ModelMessage[], options: Record<string, unknown>): ModelMessage[]
  getOptions(transformInput: Omit<ProviderTransformInput, "model"> & { model?: Provider.Model }): Record<string, any>
  getSmallOptions(): Record<string, any>
  getTemperature(): number | undefined
  getTopK(): number | undefined
  getTopP(): number | undefined
  getOutputTokenMax(): number
  getMaxOutputTokens(): number
  transformSchema(schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7
  getProviderSystemPrompt(): string[]
  getInstructionPrompt(): string
  wrapProviderOptions(options: { [x: string]: any }): Record<string, any>
  shouldUseInstructionPrompt(): boolean
  shouldIncludeProviderSystemPrompt(): boolean
  shouldDisableMaxOutputTokens(): boolean
  shouldAddNoopToolFallback(): boolean
}
