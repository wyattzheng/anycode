/**
 * LLM abstraction types — shared between agent and provider.
 *
 * These types define the interface contract for LLM streaming,
 * decoupling agent from any specific AI SDK.
 */

// ── Stream chunk types ──────────────────────────────────────────────────────

export type LLMStreamChunk =
  | { type: "start" }
  | { type: "text-start"; providerMetadata?: Record<string, any> }
  | { type: "text-delta"; text: string; providerMetadata?: Record<string, any> }
  | { type: "text-end"; providerMetadata?: Record<string, any> }
  | { type: "reasoning-start"; id: string; providerMetadata?: Record<string, any> }
  | { type: "reasoning-delta"; id: string; text: string; providerMetadata?: Record<string, any> }
  | { type: "reasoning-end"; id: string; providerMetadata?: Record<string, any> }
  | { type: "tool-input-start"; id: string; toolName: string }
  | { type: "tool-input-delta"; id: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: any; providerMetadata?: Record<string, any> }
  | { type: "tool-result"; toolCallId: string; input?: any; output: any }
  | { type: "tool-error"; toolCallId: string; input?: any; error: any }
  | { type: "start-step" }
  | { type: "finish-step"; usage: LLMUsage; finishReason: string; providerMetadata?: Record<string, any> }
  | { type: "finish" }
  | { type: "error"; error: any }

export interface LLMUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

// ── Stream result ────────────────────────────────────────────────────────────

export interface LLMStreamResult {
  fullStream: AsyncIterable<LLMStreamChunk>
}

// ── Message & tool types ─────────────────────────────────────────────────────

// Content part types — structural clones of AI SDK ModelMessage parts.
// We mirror (not re-export) to keep @any-code/utils free of `ai` dependency.

export interface LLMTextPart {
  type: "text"
  text: string
  providerOptions?: Record<string, any>
}

export interface LLMImagePart {
  type: "image"
  image: string | Uint8Array | ArrayBuffer | URL
  mediaType?: string
  providerOptions?: Record<string, any>
}

export interface LLMFilePart {
  type: "file"
  data: string | Uint8Array | ArrayBuffer | URL
  filename?: string
  mediaType: string
  providerOptions?: Record<string, any>
}

export interface LLMReasoningPart {
  type: "reasoning"
  text: string
  providerOptions?: Record<string, any>
}

export interface LLMToolCallPart {
  type: "tool-call"
  toolCallId: string
  toolName: string
  input: unknown
  providerOptions?: Record<string, any>
  providerExecuted?: boolean
}

export interface LLMToolResultPart {
  type: "tool-result"
  toolCallId: string
  toolName: string
  output: unknown
  providerOptions?: Record<string, any>
}

// Content aggregate types per role

export type LLMUserContent = string | Array<LLMTextPart | LLMImagePart | LLMFilePart>
export type LLMAssistantContent = string | Array<LLMTextPart | LLMFilePart | LLMReasoningPart | LLMToolCallPart | LLMToolResultPart>
export type LLMToolContent = Array<LLMToolResultPart>

// Role-discriminated message types

export type LLMSystemMessage = {
  role: "system"
  content: string
  providerOptions?: Record<string, any>
}

export type LLMUserMessage = {
  role: "user"
  content: LLMUserContent
  providerOptions?: Record<string, any>
}

export type LLMAssistantMessage = {
  role: "assistant"
  content: LLMAssistantContent
  providerOptions?: Record<string, any>
}

export type LLMToolMessage = {
  role: "tool"
  content: LLMToolContent
  providerOptions?: Record<string, any>
}

export type LLMMessage = LLMSystemMessage | LLMUserMessage | LLMAssistantMessage | LLMToolMessage

export interface LLMToolDef {
  id?: string
  description: string
  parameters: Record<string, any>
  execute: (input: any, options: LLMToolCallOptions) => Promise<any>
}

export interface LLMToolCallOptions {
  toolCallId: string
  abortSignal?: AbortSignal
}

// ── Stream input ─────────────────────────────────────────────────────────────

/** Canonical input for LLM streaming */
export interface LLMStreamInput {
  model: { id: string; providerID: string; [key: string]: any }
  sessionID: string
  system: string[]
  messages: LLMMessage[]
  tools: Record<string, LLMToolDef>
  toolChoice?: "auto" | "required" | "none"
  abort: AbortSignal
  small?: boolean
  retries?: number
}
