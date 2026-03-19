import type { ModelMessage } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { Flag } from "../util/flag"
import {
  applyProviderMessageTransforms,
  getProviderOptions,
  getProviderOptionsKey,
  getProviderSmallOptions,
  getProviderTemperature,
  getProviderTopK,
  transformProviderSchema,
} from "./vendors"

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
    return applyProviderMessageTransforms(msgs, model, options)
  }

  export function temperature(model: Provider.Model) {
    return getProviderTemperature(model)
  }

  export function topP(_model: Provider.Model): number | undefined {
    return undefined
  }

  export function topK(model: Provider.Model) {
    return getProviderTopK(model)
  }


  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    return getProviderOptions(input)
  }

  export function smallOptions(model: Provider.Model) {
    return getProviderSmallOptions(model)
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = getProviderOptionsKey(model)
    return { [key]: options }
  }

  export function maxOutputTokens(model: Provider.Model): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    return transformProviderSchema(model, schema)
  }
}
