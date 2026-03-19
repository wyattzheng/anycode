import type { AgentContext } from "../../context"
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

export interface ModelProvider {
  id: string
  npms?: string[]
  bundled?: Partial<Record<string, ProviderSDKFactory>>
  sdkKeys?: Partial<Record<string, string>>
  matchesRuntime?: (input: ProviderRuntimeInput) => boolean
  customLoader?: (context: AgentContext, provider: ProviderInfoLike) => Promise<ProviderLoaderResult>
  patchRequest?: (input: ProviderRequestPatchInput) => void
  transform?: VendorTransform
  llm?: VendorLLM
  prompt?: VendorPrompt
}

export interface ModelProviderAccessor {
  all(): ModelProvider[]
  getBundledProvider(): ProviderSDKFactory | undefined
  getCustomLoaders(): Record<string, (context: AgentContext, provider: ProviderInfoLike) => Promise<ProviderLoaderResult>>
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
