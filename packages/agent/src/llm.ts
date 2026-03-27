/**
 * LLM abstraction layer — decouples agent from the AI SDK.
 *
 * All AI SDK–specific types and functions are wrapped here.
 * Other agent modules import from this file instead of "ai" directly.
 */

import type { Provider } from "@any-code/provider"
import type { AgentContext } from "./context"
import type { MessageV2 } from "./memory/message-v2"

// ── Stream chunk types (what agent consumes) ────────────────────────────────

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

// ── Message types ────────────────────────────────────────────────────────────

/** Generic LLM message — decoupled from AI SDK's ModelMessage */
export type LLMMessage = { role: string; content: any }

// ── Tool definition interface ────────────────────────────────────────────────

export interface LLMToolDef {
  id?: string
  description: string
  parameters: Record<string, any>  // JSON Schema
  execute: (input: any, options: LLMToolCallOptions) => Promise<any>
}

export interface LLMToolCallOptions {
  toolCallId: string
  abortSignal?: AbortSignal
}

// ── Stream input ─────────────────────────────────────────────────────────────

export interface LLMStreamInput {
  user: MessageV2.User
  sessionID: string
  model: Provider.Model
  /** Optional system prompt override (e.g. for compaction) */
  prompt?: string
  system: string[]
  abort: AbortSignal
  messages: LLMMessage[]
  small?: boolean
  tools: Record<string, LLMToolDef>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  context: AgentContext
}
