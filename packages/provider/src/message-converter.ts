/**
 * Converts structured message history to LLM model messages.
 *
 * This module bridges between an agent's internal message representation
 * and the AI SDK's model message format, via UI message intermediary.
 */

import { convertToModelMessages } from "ai"
import type { LLMMessage } from "@any-code/utils"
import type { Provider } from "./provider"

// ── Generic input interface ─────────────────────────────────────────────────
// Structural contract — agent's WithParts satisfies this without coupling.

export interface ConvertibleMessage {
  info: {
    id: string
    role: string
    // Assistant-specific fields
    providerID?: string
    modelID?: string
    error?: any
    summary?: any
  }
  parts: ConvertiblePart[]
}

export type ConvertiblePart =
  | { type: "text"; text: string; ignored?: boolean; synthetic?: boolean; metadata?: Record<string, any> }
  | { type: "file"; mime: string; url: string; filename?: string }
  | { type: "compaction"; auto: boolean }
  | { type: "subtask"; prompt: string }
  | { type: "step-start" }
  | { type: "step-finish"; [key: string]: any }
  | { type: "reasoning"; text: string; metadata?: Record<string, any> }
  | {
    type: "tool"
    tool: string
    callID: string
    metadata?: Record<string, any>
    state:
    | { status: "pending"; input: Record<string, any> }
    | { status: "running"; input: Record<string, any> }
    | {
      status: "completed"
      input: Record<string, any>
      output: string
      time: { start: number; end: number; compacted?: number }
      attachments?: Array<{ type: "file"; mime: string; url: string; filename?: string }>
    }
    | {
      status: "error"
      input: Record<string, any>
      error: string
    }
  }
  // Catch-all: unknown part types are silently ignored by the converter
  | { type: string; [key: string]: any }

export interface ToModelMessagesOptions {
  stripMedia?: boolean
  /** Check if an error represents an aborted (not fatal) error */
  isAbortedError?: (error: any) => boolean
  /** Generate a unique ascending ID for synthetic messages */
  generateId?: () => string
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isMedia(mime: string) {
  return mime.startsWith("image/") || mime === "application/pdf"
}

// ── Main function ───────────────────────────────────────────────────────────

export function toModelMessages(
  input: ConvertibleMessage[],
  model: Provider.Model,
  options?: ToModelMessagesOptions,
): LLMMessage[] {
  const result: Array<{ id: string; role: "system" | "user" | "assistant"; parts: any[] }> = []
  const toolNames = new Set<string>()
  const supportsMediaInToolResults = (() => {
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/openai") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
    if (model.api.npm === "@ai-sdk/google") {
      const id = model.api.id.toLowerCase()
      return id.includes("gemini-3") && !id.includes("gemini-2")
    }
    return false
  })()

  const toModelOutput = (output: unknown) => {
    if (typeof output === "string") {
      return { type: "text", value: output }
    }

    if (typeof output === "object") {
      const outputObject = output as {
        text: string
        attachments?: Array<{ mime: string; url: string }>
      }
      const attachments = (outputObject.attachments ?? []).filter((attachment) => {
        return attachment.url.startsWith("data:") && attachment.url.includes(",")
      })

      return {
        type: "content",
        value: [
          { type: "text", text: outputObject.text },
          ...attachments.map((attachment) => ({
            type: "media",
            mediaType: attachment.mime,
            data: (() => {
              const commaIndex = attachment.url.indexOf(",")
              return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
            })(),
          })),
        ],
      }
    }

    return { type: "json", value: output as never }
  }

  for (const msg of input) {
    if (msg.parts.length === 0) continue

    if (msg.info.role === "user") {
      const userMessage = {
        id: msg.info.id,
        role: "user" as const,
        parts: [] as any[],
      }
      result.push(userMessage)
      for (const part of msg.parts) {
        if (part.type === "text" && !part.ignored)
          userMessage.parts.push({
            type: "text",
            text: part.text,
          })
        if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
          if (options?.stripMedia && isMedia(part.mime)) {
            userMessage.parts.push({
              type: "text",
              text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
            })
          } else {
            userMessage.parts.push({
              type: "file",
              url: part.url,
              mediaType: part.mime,
              filename: part.filename,
            })
          }
        }

        if (part.type === "compaction") {
          userMessage.parts.push({
            type: "text",
            text: "What did we do so far?",
          })
        }
        if (part.type === "subtask") {
          userMessage.parts.push({
            type: "text",
            text: "The following tool was executed by the user",
          })
        }
      }
    }

    if (msg.info.role === "assistant") {
      const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
      const media: Array<{ mime: string; url: string }> = []

      if (
        msg.info.error &&
        !(
          (options?.isAbortedError?.(msg.info.error) ?? false) &&
          msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
        )
      ) {
        continue
      }
      const assistantMessage = {
        id: msg.info.id,
        role: "assistant" as const,
        parts: [] as any[],
      }
      for (const part of msg.parts) {
        if (part.type === "text")
          assistantMessage.parts.push({
            type: "text",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        if (part.type === "step-start")
          assistantMessage.parts.push({
            type: "step-start",
          })
        if (part.type === "tool") {
          toolNames.add(part.tool)
          if (part.state.status === "completed") {
            const outputText = part.state.time.compacted ? "[Old tool result content cleared]" : part.state.output
            const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

            const mediaAttachments = attachments.filter((a: { mime: string }) => isMedia(a.mime))
            const nonMediaAttachments = attachments.filter((a: { mime: string }) => !isMedia(a.mime))
            if (!supportsMediaInToolResults && mediaAttachments.length > 0) {
              media.push(...mediaAttachments)
            }
            const finalAttachments = supportsMediaInToolResults ? attachments : nonMediaAttachments

            const output =
              finalAttachments.length > 0
                ? {
                  text: outputText,
                  attachments: finalAttachments,
                }
                : outputText

            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-available",
              toolCallId: part.callID,
              input: part.state.input,
              output,
              ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
            })
          }
          if (part.state.status === "error")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: part.state.error,
              ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
            })
          if (part.state.status === "pending" || part.state.status === "running")
            assistantMessage.parts.push({
              type: ("tool-" + part.tool) as `tool-${string}`,
              state: "output-error",
              toolCallId: part.callID,
              input: part.state.input,
              errorText: "[Tool execution was interrupted]",
              ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
            })
        }
        if (part.type === "reasoning") {
          assistantMessage.parts.push({
            type: "reasoning",
            text: part.text,
            ...(differentModel ? {} : { providerMetadata: part.metadata }),
          })
        }
      }
      if (assistantMessage.parts.length > 0) {
        result.push(assistantMessage)
        if (media.length > 0) {
          const syntheticId = options?.generateId?.() ?? `synthetic-${Date.now()}`
          result.push({
            id: syntheticId,
            role: "user",
            parts: [
              {
                type: "text" as const,
                text: "Attached image(s) from tool result:",
              },
              ...media.map((attachment) => ({
                type: "file" as const,
                url: attachment.url,
                mediaType: attachment.mime,
              })),
            ],
          })
        }
      }
    }
  }

  const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

  return convertToModelMessages(
    result.filter((msg) => msg.parts.some((part: any) => part.type !== "step-start")),
    { tools } as any,
  ) as LLMMessage[]
}
