import type { JSONSchema7 } from "@ai-sdk/provider"
import type { ModelMessage } from "ai"
import { mergeDeep } from "remeda"
import type { Provider } from "../provider"
import { Flag } from "../util/flag"
import { anthropicVendor } from "./anthropic"
import { antigravityVendor } from "./antigravity"
import { githubCopilotVendor } from "./github-copilot"
import { googleVendor } from "./google"
import { liteLLMVendor } from "./litellm"
import { openAIVendor } from "./openai"
import type {
  VendorProvider,
  VendorProviderAccessor,
  ProviderInfoLike,
  ProviderModelLike,
  ProviderRuntimeInput,
  ProviderTransformInput,
  ProviderRequestPatchInput,
} from "./types"

const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

function mimeToModality(mime: string) {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      if (part.type === "image") {
        const imageStr = part.image.toString()
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
      const filename = part.type === "file" ? part.filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

const VENDORS = [
  anthropicVendor,
  antigravityVendor,
  githubCopilotVendor,
  googleVendor,
  liteLLMVendor,
  openAIVendor,
] satisfies VendorProvider[]

const VENDORS_BY_NPM = new Map(
  VENDORS.flatMap((vendor) => (vendor.npms ?? []).map((npm) => [npm, vendor] as const)),
)

type VendorProviderSelector = {
  npm?: string
  model?: Provider.Model | ProviderModelLike
  provider?: ProviderInfoLike
  auth?: ProviderRuntimeInput["auth"]
  id?: string
}

function matchesRuntimeVendor(vendor: VendorProvider, input: ProviderRuntimeInput) {
  return (
    vendor.matchesRuntime?.(input) ||
    vendor.id === input.provider.id ||
    vendor.id === input.model.providerID ||
    vendor.npms?.includes(input.model.api.npm) === true
  )
}

function getMatchingVendors(input: VendorProviderSelector) {
  if (input.id) return VENDORS.filter((vendor) => vendor.id === input.id)
  if (input.model && input.provider) {
    return VENDORS.filter((vendor) =>
      matchesRuntimeVendor(vendor, {
        model: input.model as Provider.Model,
        provider: input.provider!,
        auth: input.auth,
      }),
    )
  }
  if (input.model) {
    const runtimeProvider = { id: input.model.providerID, options: {} } as ProviderInfoLike
    return VENDORS.filter((vendor) =>
      matchesRuntimeVendor(vendor, {
        model: input.model as Provider.Model,
        provider: runtimeProvider,
        auth: input.auth,
      }),
    )
  }
  if (input.npm) {
    const vendor = VENDORS_BY_NPM.get(input.npm)
    return vendor ? [vendor] : []
  }
  return VENDORS
}

function getSelectorNpm(input: VendorProviderSelector) {
  return input.npm ?? input.model?.api.npm
}

export const VendorRegistry = {
  getVendorProvider(input: VendorProviderSelector = {}) {
    const vendors = getMatchingVendors(input)
    const npm = getSelectorNpm(input)
    const model = input.model as Provider.Model | undefined
    const runtime = input.model
      ? {
        model: input.model as Provider.Model,
        provider: input.provider ?? { id: input.model.providerID, options: {} },
        auth: input.auth,
      }
      : undefined

    const accessor: VendorProviderAccessor = {
      all() {
        return vendors
      },

      getDefaultModel() {
        for (const vendor of vendors) {
          const model = vendor.getDefaultModel?.()
          if (model) return model
        }
        return undefined
      },

      getDefaultBaseUrl() {
        for (const vendor of vendors) {
          const baseUrl = vendor.getDefaultBaseUrl?.()
          if (baseUrl) return baseUrl
        }
        return undefined
      },

      getBrandVendor() {
        for (const vendor of vendors) {
          const brandVendor = vendor.getBrandVendor?.()
          if (brandVendor) return brandVendor
        }
        return input.id
      },

      getBundledProvider() {
        if (!npm) return undefined
        return vendors.find((vendor) => vendor.bundled?.[npm])?.bundled?.[npm]
      },

      getCustomLoaders() {
        return Object.fromEntries(vendors.flatMap((vendor) => (vendor.customLoader ? [[vendor.id, vendor.customLoader]] : [])))
      },

      getOAuth() {
        return vendors.find((vendor) => vendor.oauth)?.oauth
      },

      getOptionsKey() {
        if (!npm) return model?.providerID
        return vendors.find((vendor) => vendor.sdkKeys?.[npm])?.sdkKeys?.[npm] ?? model?.providerID
      },

      applyRequestPatch(patchInput: Omit<ProviderRequestPatchInput, "model"> & { model?: ProviderModelLike }) {
        const targetModel = patchInput.model ?? input.model
        if (!targetModel) return
        vendors.forEach((vendor) => vendor.patchRequest?.({ ...patchInput, model: targetModel }))
      },

      applyMessageTransforms(msgs: ModelMessage[], options: Record<string, unknown>) {
        if (!model) return msgs

        msgs = unsupportedParts(msgs, model)
        msgs = vendors.reduce((result, vendor) => vendor.transform?.message?.(result, model, options) ?? result, msgs)

        const key = this.getOptionsKey()
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

      getOptions(transformInput: Omit<ProviderTransformInput, "model"> & { model?: Provider.Model }) {
        const targetInput = {
          ...transformInput,
          model: transformInput.model ?? model,
        } as ProviderTransformInput
        if (!targetInput.model) return {}
        return vendors.reduce(
          (result, vendor) => mergeDeep(result, vendor.transform?.options?.(targetInput) ?? {}),
          {} as Record<string, any>,
        )
      },

      getSmallOptions() {
        if (!model) return {}
        return vendors.reduce(
          (result, vendor) => mergeDeep(result, vendor.transform?.smallOptions?.(model) ?? {}),
          {} as Record<string, any>,
        )
      },

      getTemperature() {
        if (!model) return undefined
        for (const vendor of vendors) {
          const value = vendor.transform?.temperature?.(model)
          if (value !== undefined) return value
        }
        return undefined
      },

      getTopK() {
        if (!model) return undefined
        for (const vendor of vendors) {
          const value = vendor.transform?.topK?.(model)
          if (value !== undefined) return value
        }
        return undefined
      },

      getTopP(): number | undefined {
        return undefined
      },

      getOutputTokenMax() {
        return OUTPUT_TOKEN_MAX
      },

      getMaxOutputTokens() {
        if (!model) return OUTPUT_TOKEN_MAX
        return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
      },

      transformSchema(schema: any): JSONSchema7 {
        if (!model) return schema as JSONSchema7
        return vendors.reduce(
          (result, vendor) => vendor.transform?.schema?.(model, result) ?? result,
          schema as JSONSchema7,
        )
      },

      getProviderSystemPrompt() {
        if (!model) return []
        for (const vendor of vendors) {
          const value = vendor.prompt?.provider?.(model)
          if (value !== undefined) return value
        }
        return []
      },

      getInstructionPrompt() {
        if (!model) return ""
        for (const vendor of vendors) {
          const value = vendor.prompt?.instructions?.(model)
          if (value !== undefined) return value
        }
        return ""
      },

      wrapProviderOptions(options: { [x: string]: any }) {
        return { [model?.providerID ?? '']: options }
      },

      shouldUseInstructionPrompt() {
        if (!runtime) return false
        return vendors.some((vendor) => vendor.llm?.useInstructionPrompt?.(runtime) === true)
      },

      shouldIncludeProviderSystemPrompt() {
        if (!runtime) return true
        return !vendors.some((vendor) => vendor.llm?.includeProviderSystemPrompt?.(runtime) === false)
      },

      shouldDisableMaxOutputTokens() {
        if (!runtime) return false
        return vendors.some((vendor) => vendor.llm?.disableMaxOutputTokens?.(runtime) === true)
      },

      shouldAddNoopToolFallback() {
        if (!runtime) return false
        return vendors.some((vendor) => vendor.llm?.needsNoopToolFallback?.(runtime) === true)
      },
    }

    return accessor
  },
}
