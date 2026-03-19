import { createAnthropic } from "@ai-sdk/anthropic"
import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import PROMPT_ANTHROPIC from "../../prompt/prompt/anthropic.txt"
import { CLAUDE_CODE_SYSTEM } from "../../prompt/prompt/anthropic.txt"
import { Hash } from "../../util/hash"
import type { VendorProvider } from "./types"

export const anthropicVendor: VendorProvider = {
  id: "anthropic",
  npm: "@ai-sdk/anthropic",
  bundled: createAnthropic,
  sdkKey: "anthropic",
  async customLoader() {
    return {
      autoload: false,
      options: {
        headers: {
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          "X-App": "cli",
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": "0.70.0",
          "X-Stainless-OS": process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
          "X-Stainless-Arch": process.arch === "arm64" ? "arm64" : "x64",
          "X-Stainless-Runtime": "node",
          "X-Stainless-Runtime-Version": process.version,
          "X-Stainless-Retry-Count": "0",
          "X-Stainless-Timeout": "600",
          "Anthropic-Dangerous-Direct-Browser-Access": "true",
        },
      },
    }
  },
  patchRequest({ opts, model, provider }) {
    if (opts.headers) {
      const headers = new Headers(opts.headers as HeadersInit)
      headers.set("user-agent", "claude-cli/2.1.77")
      opts.headers = Object.fromEntries(headers.entries())
    } else {
      opts.headers = { "user-agent": "claude-cli/2.1.77" }
    }

    if (opts.body && opts.method === "POST") {
      try {
        const body = JSON.parse(opts.body as string)

        if (!body.metadata?.user_id) {
          if (!body.metadata) body.metadata = {}
          const seed = [model.providerID ?? "", provider.key ?? ""].join(":")
          const clientId = Hash.sha256(seed + ":claude-code-client")
          const uuid = Hash.hexToUUID(Hash.sha256(seed + ":session"))
          body.metadata.user_id = `user_${clientId}_account__session_${uuid}`
        }

        if (Array.isArray(body.system)) {
          const alreadyPresent = body.system.some(
            (entry: any) => typeof entry.text === "string" && entry.text.startsWith(CLAUDE_CODE_SYSTEM),
          )
          if (!alreadyPresent) {
            body.system.unshift({
              type: "text",
              text: CLAUDE_CODE_SYSTEM,
              cache_control: { type: "ephemeral" },
            })
          }
        }

        opts.body = JSON.stringify(body)
      } catch {
        // Ignore parse errors
      }
    }
  },
  transform: {
    message(msgs, model) {
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

      if (model.api.id.includes("claude")) {
        msgs = msgs.map((msg) => {
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

      if (model.providerID === "anthropic" || model.api.id.includes("claude") || model.api.npm === "@ai-sdk/anthropic") {
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
      }

      return msgs
    },
    options({ model }) {
      if (model.api.npm !== "@ai-sdk/anthropic") return {}

      const isAdaptive = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) =>
        model.api.id.includes(v),
      )
      if (isAdaptive) {
        return { thinking: { type: "adaptive" } }
      }

      return {
        thinking: {
          type: "enabled",
          budgetTokens: model.limit.output - 1,
        },
      }
    },
  },
  prompt: {
    provider(model) {
      if (!model.api.id.includes("claude")) return undefined
      return [PROMPT_ANTHROPIC]
    },
  },
}
