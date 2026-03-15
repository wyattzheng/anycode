import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { Flag } from "../util/flag"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/openai":
        return "openai"
      case "@ai-sdk/anthropic":
        return "anthropic"
      case "@ai-sdk/google":
        return "google"
    }
    return undefined
  }

  function normalizeMessages(
    msgs: ModelMessage[],
    model: Provider.Model,
    _options: Record<string, unknown>,
  ): ModelMessage[] {
    // Strip reasoning parts from historical messages for openai-compatible providers.
    // When proxied to Anthropic, reasoning_content becomes a thinking block that
    // requires a signature field — which we don't have. Reasoning from previous
    // turns is not needed for context, so stripping it is safe and prevents errors.
    if (model.api.npm === "@ai-sdk/openai-compatible") {
      msgs = msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const filtered = msg.content.filter((part: any) => part.type !== "reasoning")
          if (filtered.length === 0) return msg
          return { ...msg, content: filtered }
        }
        return msg
      })
    }

    // Anthropic rejects messages with empty content
    if (model.api.npm === "@ai-sdk/anthropic") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text" || part.type === "reasoning") {
              return part.text !== ""
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    // Normalize tool call IDs for Claude
    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return {
                ...part,
                toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              }
            }
            return part
          })
        }
        return msg
      })
    }

    // Handle interleaved reasoning for openai-compatible providers
    if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [field]: reasoningText,
                },
              },
            }
          }

          return { ...msg, content: filteredContent }
        }
        return msg
      })
    }

    return msgs
  }

  function applyCaching(msgs: ModelMessage[], _model: Provider.Model): ModelMessage[] {
    const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
    const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
    }

    for (const msg of unique([...system, ...final])) {
      msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
    }

    return msgs
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
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

  export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)

    // Apply caching for Anthropic models
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    ) {
      msgs = applyCaching(msgs, model)
    }

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID) {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) => ({ ...part, providerOptions: remap(part.providerOptions) })),
        } as typeof msg
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    return undefined
  }

  export function topP(_model: Provider.Model): number | undefined {
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("gemini")) return 64
    return undefined
  }

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const id = model.id.toLowerCase()
    const isAnthropicAdaptive = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) =>
      model.api.id.includes(v),
    )
    const adaptiveEfforts = ["low", "medium", "high", "max"]

    switch (model.api.npm) {
      case "@ai-sdk/openai-compatible":
        return Object.fromEntries(["low", "medium", "high"].map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/openai": {
        if (id === "gpt-5-pro") return {}
        const efforts = ["low", "medium", "high"]
        if (id.includes("gpt-5-") || id === "gpt-5") efforts.unshift("minimal")
        if (model.release_date >= "2025-11-13") efforts.unshift("none")
        if (model.release_date >= "2025-12-04") efforts.push("xhigh")
        return Object.fromEntries(
          efforts.map((effort) => [
            effort,
            { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
          ]),
        )
      }

      case "@ai-sdk/anthropic":
        if (isAnthropicAdaptive) {
          return Object.fromEntries(
            adaptiveEfforts.map((effort) => [effort, { thinking: { type: "adaptive" }, effort }]),
          )
        }
        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/google": {
        if (id.includes("2.5")) {
          return {
            high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
            max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
          }
        }
        let levels = ["low", "high"]
        if (id.includes("3.1")) levels = ["low", "medium", "high"]
        return Object.fromEntries(
          levels.map((effort) => [effort, { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }]),
        )
      }
    }
    return {}
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}
    const model = input.model

    // OpenAI: set store to false by default
    if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
      result["store"] = false
    }

    if (model.providerID === "openai" || input.providerOptions?.setCacheKey) {
      result["promptCacheKey"] = input.sessionID
    }

    // Google/Gemini: enable thinking
    if (model.api.npm === "@ai-sdk/google") {
      result["thinkingConfig"] = { includeThoughts: true }
      if (model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    // GPT-5 reasoning defaults
    if (model.api.id.includes("gpt-5") && !model.api.id.includes("gpt-5-chat")) {
      if (!model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
        result["reasoningSummary"] = "auto"
      }
      if (model.api.id.includes("gpt-5.") && !model.api.id.includes("codex") && !model.api.id.includes("-chat")) {
        result["textVerbosity"] = "low"
      }
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.")) return { store: false, reasoningEffort: "low" }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    }
    if (model.providerID === "google") {
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    return {}
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = sdkKey(model.api.npm) ?? model.providerID
    return { [key]: options }
  }

  export function maxOutputTokens(model: Provider.Model): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const isPlainObject = (node: unknown): node is Record<string, any> =>
        typeof node === "object" && node !== null && !Array.isArray(node)
      const hasCombiner = (node: unknown) =>
        isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
      const hasSchemaIntent = (node: unknown) => {
        if (!isPlainObject(node)) return false
        if (hasCombiner(node)) return true
        return [
          "type", "properties", "items", "prefixItems", "enum", "const",
          "$ref", "additionalProperties", "patternProperties", "required",
          "not", "if", "then", "else",
        ].some((key) => key in node)
      }

      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") return obj
        if (Array.isArray(obj)) return obj.map(sanitizeGemini)

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            result[key] = value.map((v) => String(v))
            if (result.type === "integer" || result.type === "number") result.type = "string"
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }
        if (result.type === "array" && !hasCombiner(result)) {
          if (result.items == null) result.items = {}
          if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) result.items.type = "string"
        }
        if (result.type && result.type !== "object" && !hasCombiner(result)) {
          delete result.properties
          delete result.required
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema as JSONSchema7
  }
}
