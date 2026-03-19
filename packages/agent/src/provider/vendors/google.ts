import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { JSONSchema7 } from "@ai-sdk/provider"
import PROMPT_GEMINI from "../../prompt/prompt/gemini.txt"
import type { VendorProvider } from "./types"

export const googleVendor: VendorProvider = {
  id: "google",
  npm: "@ai-sdk/google",
  bundled: createGoogleGenerativeAI,
  sdkKey: "google",
  transform: {
    options({ model }) {
      if (model.api.npm !== "@ai-sdk/google") return {}

      const thinkingConfig: Record<string, any> = { includeThoughts: true }
      if (model.api.id.includes("gemini-3")) {
        thinkingConfig["thinkingLevel"] = "high"
      }
      return { thinkingConfig }
    },
    smallOptions(model) {
      if (model.providerID !== "google") return {}
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    },
    temperature(model) {
      return model.id.toLowerCase().includes("gemini") ? 1.0 : undefined
    },
    topK(model) {
      return model.id.toLowerCase().includes("gemini") ? 64 : undefined
    },
    schema(model, schema) {
      if (!(model.providerID === "google" || model.api.id.includes("gemini"))) return schema as JSONSchema7

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

      const sanitize = (obj: any): any => {
        if (obj === null || typeof obj !== "object") return obj
        if (Array.isArray(obj)) return obj.map(sanitize)

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            result[key] = value.map((v) => String(v))
            if (result.type === "integer" || result.type === "number") result.type = "string"
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitize(value)
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

      return sanitize(schema) as JSONSchema7
    },
  },
  prompt: {
    provider(model) {
      if (!model.api.id.includes("gemini-")) return undefined
      return [PROMPT_GEMINI]
    },
  },
}
