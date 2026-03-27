import z from "zod"

// ── Schemas ────────────────────────────────────────────────────────────────

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
      context_over_200k: z
        .object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  limit: z.object({
    context: z.number(),
    input: z.number().optional(),
    output: z.number(),
  }),
  modalities: z
    .object({
      input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    })
    .optional(),
  experimental: z.boolean().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  options: z.record(z.string(), z.any()),
  headers: z.record(z.string(), z.string()).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
})

export type ModelInfo = z.infer<typeof ModelSchema>

export const ProviderSchema = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), ModelSchema),
})

export type ProviderInfo = z.infer<typeof ProviderSchema>

export type ModelsDatabase = Record<string, ProviderInfo>

// ── Service ────────────────────────────────────────────────────────────────

const DEFAULT_URL = "https://models.dev"

export interface ModelInfoOptions {
  /** Override the models.dev API URL */
  url?: string
  /** Timeout for fetch in ms (default: 10000) */
  timeout?: number
  /** Read cached JSON from a file path. Return parsed object or undefined if not found. */
  readCache?: () => Promise<ModelsDatabase | undefined>
  /** Write fetched data to cache file. */
  writeCache?: (data: ModelsDatabase) => Promise<void>
  /** If true, don't fetch from remote. Only use cache. */
  disableFetch?: boolean
}

/**
 * ModelInfoService — loads and caches model metadata.
 *
 * Resolution order: cache file → remote fetch → empty
 */
export class ModelInfoService {
  readonly ready: Promise<ModelsDatabase>

  constructor(options?: ModelInfoOptions) {
    this.ready = this.init(options ?? {})
  }

  private async init(opts: ModelInfoOptions): Promise<ModelsDatabase> {
    // 1. Try cache
    if (opts.readCache) {
      try {
        const cached = await opts.readCache()
        if (cached) return cached
      } catch {}
    }

    // 2. Fetch from remote
    if (!opts.disableFetch) {
      try {
        return await fetchModels(opts)
      } catch {}
    }

    return {}
  }
}

/**
 * Fetch the full models database from models.dev
 */
export async function fetchModels(options?: { url?: string; timeout?: number }): Promise<ModelsDatabase> {
  const url = options?.url ?? DEFAULT_URL
  const timeout = options?.timeout ?? 10_000
  const response = await fetch(`${url}/api.json`, {
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<ModelsDatabase>
}

/**
 * Refresh and save model data to cache
 */
export async function refreshModels(options?: ModelInfoOptions): Promise<void> {
  const data = await fetchModels(options)
  if (options?.writeCache) {
    await options.writeCache(data)
  }
}

/**
 * Look up a specific model's info
 */
export function getModel(db: ModelsDatabase, providerId: string, modelId: string): ModelInfo | undefined {
  return db[providerId]?.models?.[modelId]
}

/**
 * Get the cost for a model (USD per million tokens)
 */
export function getModelCost(db: ModelsDatabase, providerId: string, modelId: string) {
  const model = getModel(db, providerId, modelId)
  if (!model?.cost) return undefined
  return {
    input: model.cost.input,
    output: model.cost.output,
    cacheRead: model.cost.cache_read ?? 0,
    cacheWrite: model.cost.cache_write ?? 0,
  }
}
