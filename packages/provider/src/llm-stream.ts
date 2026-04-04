/**
 * AI SDK Stream Adapter — implements LLM stream interface using Vercel AI SDK.
 *
 * This is the ONLY file in the entire system that imports from "ai" directly.
 * It converts LLMToolDef → AI SDK tool(), resolves model options,
 * and wraps streamText() into LLMStreamResult.
 */
import { tool as aiTool, jsonSchema, wrapLanguageModel, streamText, convertToModelMessages, APICallError, LoadAPIKeyError } from "ai"
import { mergeDeep, pipe } from "remeda"

import { VendorRegistry } from "./vendors"
import type { Provider } from "./provider"
import type {
  LLMStreamResult,
  LLMStreamChunk,
  LLMToolDef,
  LLMMessage,
  LLMStreamInput,
} from "@any-code/utils"

export interface StreamAdapterContext {
  provider: {
    getLanguage(model: Provider.Model): Promise<any>
    getProvider(providerID: string): Promise<any>
  }
  auth: {
    get(providerID: string): Promise<any>
  }
  config?: {
    experimental?: { openTelemetry?: boolean }
    username?: string
  }
  systemPrompt?: {
    provider(model: Provider.Model): string[]
    instructions(model: Provider.Model): string
  }
  log?: {
    info(msg: string, meta?: any): void
    error(msg: string, meta?: any): void
  }
}

export async function createLLMStream(
  ctx: StreamAdapterContext,
  input: Omit<LLMStreamInput, 'model'> & { model: Provider.Model },
): Promise<LLMStreamResult> {
  const log = ctx.log ?? { info() {}, error() {} }

  const [language, provider, auth] = await Promise.all([
    ctx.provider.getLanguage(input.model),
    ctx.provider.getProvider(input.model.providerID),
    ctx.auth.get(input.model.providerID),
  ])
  const runtime = { model: input.model, provider, auth }
  const vendorProvider = VendorRegistry.getVendorProvider(runtime)

  const base = input.small
    ? vendorProvider.getSmallOptions()
    : vendorProvider.getOptions({
      model: input.model,
      sessionID: input.sessionID,
      providerOptions: provider.options,
    })
  const options: Record<string, any> = pipe(
    base,
    mergeDeep(input.model.options),
  )

  if (vendorProvider.shouldUseInstructionPrompt() && ctx.systemPrompt) {
    options.instructions = ctx.systemPrompt.instructions(input.model)
  }

  const params = {
    temperature: input.model.capabilities.temperature
      ? vendorProvider.getTemperature()
      : undefined,
    topP: vendorProvider.getTopP(),
    topK: vendorProvider.getTopK(),
    options,
  }

  const maxOutputTokens = vendorProvider.shouldDisableMaxOutputTokens()
    ? undefined
    : vendorProvider.getMaxOutputTokens()

  // Convert LLMToolDef → AI SDK tool()
  const tools: Record<string, any> = {}
  for (const [name, def] of Object.entries(input.tools) as [string, LLMToolDef][]) {
    tools[name] = aiTool({
      id: def.id ?? name as any,
      description: def.description,
      inputSchema: jsonSchema(def.parameters as any),
      execute: def.execute as any,
    })
  }

  const sdkResult = streamText({
    onError(error) {
      log.error("stream error", { error })
    },
    async experimental_repairToolCall(failed) {
      const lower = failed.toolCall.toolName.toLowerCase()
      if (lower !== failed.toolCall.toolName && tools[lower]) {
        log.info("repairing tool call", {
          tool: failed.toolCall.toolName,
          repaired: lower,
        })
        return {
          ...failed.toolCall,
          toolName: lower,
        }
      }
      return {
        ...failed.toolCall,
        input: JSON.stringify({
          tool: failed.toolCall.toolName,
          error: failed.error.message,
        }),
        toolName: "invalid",
      }
    },
    temperature: params.temperature,
    topP: params.topP,
    topK: params.topK,
    providerOptions: vendorProvider.wrapProviderOptions(params.options),
    activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
    tools,
    toolChoice: input.toolChoice,
    maxOutputTokens,
    abortSignal: input.abort,
    headers: {
      ...input.model.headers,
    },
    maxRetries: input.retries ?? 0,
    messages: [
      ...input.system.map(
        (x: string): LLMMessage => ({
          role: "system",
          content: x,
        }),
      ),
      ...input.messages,
    ] as any,
    model: wrapLanguageModel({
      model: language,
      middleware: [
        {
          async transformParams(args) {
            if (args.type === "stream") {
              // @ts-expect-error
              args.params.prompt = vendorProvider.applyMessageTransforms(args.params.prompt, options)
            }
            return args.params
          },
        },
      ],
    }),
    experimental_telemetry: {
      isEnabled: ctx.config?.experimental?.openTelemetry,
      metadata: {
        userId: ctx.config?.username ?? "unknown",
        sessionId: input.sessionID,
      },
    },
  })

  return {
    fullStream: sdkResult.fullStream as AsyncIterable<LLMStreamChunk>,
  }
}

// ── Helpers (so agent doesn't need to import "ai") ──────────────────────────

/** Convert UI messages to model messages */
export function convertUIToModelMessages(
  messages: any[],
  tools: Record<string, { toModelOutput: (output: unknown) => any }>,
): LLMMessage[] {
  return convertToModelMessages(messages, { tools } as any) as LLMMessage[]
}

/** Check if error is an API call error */
export function isAPICallError(e: unknown): boolean {
  return APICallError.isInstance(e)
}

/** Check if error is a load API key error */
export function isLoadAPIKeyError(e: unknown): boolean {
  return LoadAPIKeyError.isInstance(e)
}
