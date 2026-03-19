import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ModelMessage } from "ai"
import { mergeDeep } from "remeda"
import type { Provider } from "../provider"
import { anthropicVendor } from "./anthropic"
import { githubCopilotVendor } from "./github-copilot"
import { googleVendor } from "./google"
import { liteLLMVendor } from "./litellm"
import { openAICompatibleVendor } from "./openai-compatible"
import { openAIVendor } from "./openai"
import type { ProviderRuntimeInput, ProviderTransformInput, ProviderRequestPatchInput, VendorProvider } from "./types"

const VENDORS = [
  anthropicVendor,
  githubCopilotVendor,
  googleVendor,
  liteLLMVendor,
  openAICompatibleVendor,
  openAIVendor,
] satisfies VendorProvider[]

const VENDORS_BY_NPM = new Map(VENDORS.map((vendor) => [vendor.npm, vendor]))

function matchesRuntimeVendor(vendor: VendorProvider, input: ProviderRuntimeInput) {
  return (
    vendor.matchesRuntime?.(input) ||
    vendor.id === input.provider.id ||
    vendor.id === input.model.providerID ||
    vendor.npm === input.model.api.npm
  )
}

export const VendorRegistry = {
  all() {
    return VENDORS
  },

  bundledProviders() {
    return Object.fromEntries(
      VENDORS.filter((vendor) => !(vendor.matchesRuntime || vendor.llm)).map((vendor) => [vendor.npm, vendor.bundled]),
    )
  },

  customLoaders() {
    return Object.fromEntries(VENDORS.flatMap((vendor) => (vendor.customLoader ? [[vendor.id, vendor.customLoader]] : [])))
  },

  getOptionsKey(model: Provider.Model) {
    return VENDORS_BY_NPM.get(model.api.npm)?.sdkKey ?? model.providerID
  },

  applyRequestPatch(input: ProviderRequestPatchInput) {
    VENDORS_BY_NPM.get(input.model.api.npm)?.patchRequest?.(input)
  },

  applyMessageTransforms(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    msgs = VENDORS.reduce((result, vendor) => vendor.transform?.message?.(result, model, options) ?? result, msgs)

    const key = VENDORS_BY_NPM.get(model.api.npm)?.sdkKey
    if (!key || key === model.providerID) return msgs

    const remap = (opts: Record<string, any> | undefined) => {
      if (!opts) return opts
      if (!(model.providerID in opts)) return opts
      const result = { ...opts }
      result[key] = result[model.providerID]
      delete result[model.providerID]
      return result
    }

    return msgs.map((msg) => {
      if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
      return {
        ...msg,
        providerOptions: remap(msg.providerOptions),
        content: msg.content.map((part) => ({ ...part, providerOptions: remap(part.providerOptions) })),
      } as typeof msg
    })
  },

  getOptions(input: ProviderTransformInput) {
    return VENDORS.reduce(
      (result, vendor) => mergeDeep(result, vendor.transform?.options?.(input) ?? {}),
      {} as Record<string, any>,
    )
  },

  getSmallOptions(model: Provider.Model) {
    return VENDORS.reduce(
      (result, vendor) => mergeDeep(result, vendor.transform?.smallOptions?.(model) ?? {}),
      {} as Record<string, any>,
    )
  },

  getTemperature(model: Provider.Model) {
    for (const vendor of VENDORS) {
      const value = vendor.transform?.temperature?.(model)
      if (value !== undefined) return value
    }
    return undefined
  },

  getTopK(model: Provider.Model) {
    for (const vendor of VENDORS) {
      const value = vendor.transform?.topK?.(model)
      if (value !== undefined) return value
    }
    return undefined
  },

  transformSchema(model: Provider.Model, schema: any): JSONSchema7 {
    return VENDORS.reduce(
      (result, vendor) => vendor.transform?.schema?.(model, result) ?? result,
      schema as JSONSchema7,
    )
  },

  getProviderSystemPrompt(model: Provider.Model) {
    for (const vendor of VENDORS) {
      const value = vendor.prompt?.provider?.(model)
      if (value !== undefined) return value
    }
    return []
  },

  getInstructionPrompt(model: Provider.Model) {
    for (const vendor of VENDORS) {
      const value = vendor.prompt?.instructions?.(model)
      if (value !== undefined) return value
    }
    return ""
  },

  shouldUseInstructionPrompt(input: ProviderRuntimeInput) {
    return VENDORS.some((vendor) => matchesRuntimeVendor(vendor, input) && vendor.llm?.useInstructionPrompt?.(input) === true)
  },

  shouldIncludeProviderSystemPrompt(input: ProviderRuntimeInput) {
    return !VENDORS.some(
      (vendor) => matchesRuntimeVendor(vendor, input) && vendor.llm?.includeProviderSystemPrompt?.(input) === false,
    )
  },

  shouldDisableMaxOutputTokens(input: ProviderRuntimeInput) {
    return VENDORS.some((vendor) => matchesRuntimeVendor(vendor, input) && vendor.llm?.disableMaxOutputTokens?.(input) === true)
  },

  shouldAddNoopToolFallback(input: ProviderRuntimeInput) {
    return VENDORS.some((vendor) => matchesRuntimeVendor(vendor, input) && vendor.llm?.needsNoopToolFallback?.(input) === true)
  },
}

export const BUNDLED_PROVIDERS = VendorRegistry.bundledProviders()
export const CUSTOM_LOADERS = VendorRegistry.customLoaders()

export const applyProviderRequestPatch = VendorRegistry.applyRequestPatch.bind(VendorRegistry)
export const applyProviderMessageTransforms = VendorRegistry.applyMessageTransforms.bind(VendorRegistry)
export const getProviderOptions = VendorRegistry.getOptions.bind(VendorRegistry)
export const getProviderSmallOptions = VendorRegistry.getSmallOptions.bind(VendorRegistry)
export const getProviderTemperature = VendorRegistry.getTemperature.bind(VendorRegistry)
export const getProviderTopK = VendorRegistry.getTopK.bind(VendorRegistry)
export const transformProviderSchema = VendorRegistry.transformSchema.bind(VendorRegistry)
export const getProviderOptionsKey = VendorRegistry.getOptionsKey.bind(VendorRegistry)
export const getProviderSystemPrompt = VendorRegistry.getProviderSystemPrompt.bind(VendorRegistry)
export const getInstructionPrompt = VendorRegistry.getInstructionPrompt.bind(VendorRegistry)
export const shouldUseInstructionPrompt = VendorRegistry.shouldUseInstructionPrompt.bind(VendorRegistry)
export const shouldIncludeProviderSystemPrompt = VendorRegistry.shouldIncludeProviderSystemPrompt.bind(VendorRegistry)
export const shouldDisableMaxOutputTokens = VendorRegistry.shouldDisableMaxOutputTokens.bind(VendorRegistry)
export const shouldAddNoopToolFallback = VendorRegistry.shouldAddNoopToolFallback.bind(VendorRegistry)
