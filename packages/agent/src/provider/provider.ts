import type { AgentContext } from "../context"
import z from "zod"
import fuzzysort from "fuzzysort"
import { mapValues, mergeDeep, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util/log"
import { Hash } from "../util/hash"
import { NamedError } from "../util/error"
import { ModelsDev } from "./models"
import { Auth } from "../util/auth"

import { Flag } from "../util/flag"
import { iife } from "../util/fn"

import type { LanguageModelV2 } from "@ai-sdk/provider"
import { ModelID, ProviderID } from "./schema"
import { VendorRegistry } from "./vendors"
import type { ProviderLoaderResult, ProviderModelLoader, ProviderVarsLoader } from "./vendors/types"

const DEFAULT_CHUNK_TIMEOUT = 120_000

export namespace Provider {
  const log = Log.create({ service: "provider" })


  function wrapSSE(res: Response, ms: number, ctl: AbortController) {
    if (typeof ms !== "number" || ms <= 0) return res
    if (!res.body) return res
    if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

    const reader = res.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const id = setTimeout(() => {
            const err = new Error("SSE read timed out")
            ctl.abort(err)
            void reader.cancel(err)
            reject(err)
          }, ms)

          reader.read().then(
            (part) => {
              clearTimeout(id)
              resolve(part)
            },
            (err) => {
              clearTimeout(id)
              reject(err)
            },
          )
        })

        if (part.done) {
          ctrl.close()
          return
        }

        ctrl.enqueue(part.value)
      },
      async cancel(reason) {
        ctl.abort(reason)
        await reader.cancel(reason)
      },
    })

    return new Response(body, {
      headers: new Headers(res.headers),
      status: res.status,
      statusText: res.statusText,
    })
  }
  export const Model = z
    .object({
      id: ModelID.zod,
      providerID: ProviderID.zod,
      api: z.object({
        id: z.string(),
        url: z.string(),
        npm: z.string(),
      }),
      name: z.string(),
      family: z.string().optional(),
      capabilities: z.object({
        temperature: z.boolean(),
        reasoning: z.boolean(),
        attachment: z.boolean(),
        toolcall: z.boolean(),
        input: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        output: z.object({
          text: z.boolean(),
          audio: z.boolean(),
          image: z.boolean(),
          video: z.boolean(),
          pdf: z.boolean(),
        }),
        interleaved: z.union([
          z.boolean(),
          z.object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          }),
        ]),
      }),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
        experimentalOver200K: z
          .object({
            input: z.number(),
            output: z.number(),
            cache: z.object({
              read: z.number(),
              write: z.number(),
            }),
          })
          .optional(),
      }),
      limit: z.object({
        context: z.number(),
        input: z.number().optional(),
        output: z.number(),
      }),
      status: z.enum(["alpha", "beta", "deprecated", "active"]),
      options: z.record(z.string(), z.any()),
      headers: z.record(z.string(), z.string()),
      release_date: z.string(),
      variants: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .meta({
      ref: "Model",
    })
  export type Model = z.infer<typeof Model>

  export const Info = z
    .object({
      id: ProviderID.zod,
      name: z.string(),
      source: z.enum(["env", "config", "custom", "api"]),
      env: z.string().array(),
      key: z.string().optional(),
      options: z.record(z.string(), z.any()),
      models: z.record(z.string(), Model),
    })
    .meta({
      ref: "Provider",
    })
  export type Info = z.infer<typeof Info>

  function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
    const m: Model = {
      id: ModelID.make(model.id),
      providerID: ProviderID.make(provider.id),
      name: model.name,
      family: model.family,
      api: {
        id: model.id,
        url: model.provider?.api ?? provider.api!,
        npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
      },
      status: model.status ?? "active",
      headers: model.headers ?? {},
      options: model.options ?? {},
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cache: {
          read: model.cost?.cache_read ?? 0,
          write: model.cost?.cache_write ?? 0,
        },
        experimentalOver200K: model.cost?.context_over_200k
          ? {
            cache: {
              read: model.cost.context_over_200k.cache_read ?? 0,
              write: model.cost.context_over_200k.cache_write ?? 0,
            },
            input: model.cost.context_over_200k.input,
            output: model.cost.context_over_200k.output,
          }
          : undefined,
      },
      limit: {
        context: model.limit.context,
        input: model.limit.input,
        output: model.limit.output,
      },
      capabilities: {
        temperature: model.temperature,
        // Always true: non-thinking models simply won't produce thinking blocks,
        // but thinking models require this to properly handle signatures in history replay.
        reasoning: true,
        attachment: model.attachment,
        toolcall: model.tool_call,
        input: {
          text: model.modalities?.input?.includes("text") ?? false,
          audio: model.modalities?.input?.includes("audio") ?? false,
          image: model.modalities?.input?.includes("image") ?? false,
          video: model.modalities?.input?.includes("video") ?? false,
          pdf: model.modalities?.input?.includes("pdf") ?? false,
        },
        output: {
          text: model.modalities?.output?.includes("text") ?? false,
          audio: model.modalities?.output?.includes("audio") ?? false,
          image: model.modalities?.output?.includes("image") ?? false,
          video: model.modalities?.output?.includes("video") ?? false,
          pdf: model.modalities?.output?.includes("pdf") ?? false,
        },
        interleaved: model.interleaved ?? false,
      },
      release_date: model.release_date,
      variants: {},
    }

    return m
  }

  export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
    return {
      id: ProviderID.make(provider.id),
      source: "custom",
      name: provider.name,
      env: provider.env ?? [],
      options: {},
      models: mapValues(provider.models, (model) => fromModelsDevModel(provider, model)),
    }
  }

  /**
   * ProviderService — caches resolved LLM providers and SDK instances.
   */
  /**
   * ProviderService — manages provider initialization, SDK instances, and model resolution.
   * All logic is now in instance methods.
   */
  export class ProviderService {
    readonly _promise: ReturnType<ProviderService["init"]>
    private context!: AgentContext

    constructor(context: AgentContext) {
      this._promise = this.init(context)
    }

    bind(context: AgentContext) {
      this.context = context
    }


    async list() {
      return this._promise.then((state) => state.providers)
    }

    async getProvider(providerID: ProviderID) {
      return this._promise.then((s) => s.providers[providerID])
    }

    async getModel(providerID: ProviderID, modelID: ModelID) {
      const s = await this._promise
      const provider = s.providers[providerID]
      if (!provider) {
        const availableProviders = Object.keys(s.providers)
        const matches = fuzzysort.go(providerID, availableProviders, { limit: 3, threshold: -10000 })
        const suggestions = matches.map((m) => m.target)
        throw new ModelNotFoundError({ providerID, modelID, suggestions })
      }

      const info = provider.models[modelID]
      if (!info) {
        const availableModels = Object.keys(provider.models)
        const matches = fuzzysort.go(modelID, availableModels, { limit: 3, threshold: -10000 })
        const suggestions = matches.map((m) => m.target)
        throw new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    }

    async getLanguage(model: Model): Promise<LanguageModelV2> {
      const s = await this._promise
      const key = `${model.providerID}/${model.id}`
      if (s.models.has(key)) return s.models.get(key)!

      const provider = s.providers[model.providerID]
      const sdk = await this.getSDK(model)

      try {
        const language = s.modelLoaders[model.providerID]
          ? await s.modelLoaders[model.providerID](sdk, model.api.id, provider.options)
          : sdk.languageModel(model.api.id)
        s.models.set(key, language)
        return language
      } catch (e) {
        if (e instanceof NoSuchModelError)
          throw new ModelNotFoundError(
            {
              modelID: model.id,
              providerID: model.providerID,
            },
            { cause: e },
          )
        throw e
      }
    }

    async closest(providerID: ProviderID, query: string[]) {
      const s = await this._promise
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item))
            return {
              providerID,
              modelID,
            }
        }
      }
    }

    async getSmallModel(providerID: ProviderID) {
      const cfg = this.context.config

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return this.getModel(parsed.providerID, parsed.modelID)
      }

      const provider = await this._promise.then((state) => state.providers[providerID])
      if (provider) {
        const priority = [
          "claude-haiku-4-5",
          "claude-haiku-4.5",
          "3-5-haiku",
          "3.5-haiku",
          "gemini-3-flash",
          "gemini-2.5-flash",
          "gpt-5-nano",
        ]
        for (const item of priority) {
          for (const model of Object.keys(provider.models)) {
            if (model.includes(item)) return this.getModel(providerID, ModelID.make(model))
          }
        }
      }

      return undefined
    }

    async defaultModel() {
      const cfg = this.context.config
      if (cfg.model) return parseModel(cfg.model)

      const providers = await this.list()
      const provider = Object.values(providers).find((p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id))
      if (!provider) throw new Error("no providers found")
      const [model] = sort(Object.values(provider.models) as any)
      if (!model) throw new Error("no models found")
      return {
        providerID: provider.id as any,
        modelID: model.id as any,
      } as any
    }

    private async getSDK(model: Model) {
      try {
        using _ = log.time("getSDK", {
          providerID: model.providerID,
        })
        const s = await this._promise
        const provider = s.providers[model.providerID]
        const options = { ...provider.options }



        if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
          options["includeUsage"] = true
        }

        const baseURL = iife(() => {
          let url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return

          // some models/providers have variable urls, ex: "https://${AZURE_RESOURCE_NAME}.services.ai.azure.com/anthropic/v1"
          // We track this in models.dev, and then when we are resolving the baseURL
          // we need to string replace that literal: "${AZURE_RESOURCE_NAME}"
          const loader = s.varsLoaders[model.providerID]
          if (loader) {
            const vars = loader(options)
            for (const [key, value] of Object.entries(vars)) {
              const field = "${" + key + "}"
              url = url.replaceAll(field, value)
            }
          }

          url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
            const val = this.context.env.get(String(key))
            return val ?? item
          })
          return url
        })

        if (baseURL !== undefined) options["baseURL"] = baseURL
        if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }

        const key = Hash.fast(JSON.stringify({ providerID: model.providerID, npm: model.api.npm, options }))
        const existing = s.sdk.get(key)
        if (existing) return existing

        const customFetch = options["fetch"]
        const chunkTimeout = options["chunkTimeout"] || DEFAULT_CHUNK_TIMEOUT
        delete options["chunkTimeout"]

        options["fetch"] = async (input: any, init?: RequestInit) => {
          // Preserve custom fetch if it exists, wrap it with timeout logic
          const fetchFn = customFetch ?? fetch
          const opts = init ?? {}
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          VendorRegistry.getModelProvider({ model }).applyRequestPatch({ opts, provider })

          const res = await fetchFn(input, {
            ...opts,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          })

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const bundledFn = VendorRegistry.getModelProvider({ npm: model.api.npm }).getBundledProvider()
        if (bundledFn) {
          log.info("using bundled provider", { providerID: model.providerID, pkg: model.api.npm })
          const loaded = bundledFn({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        }

        throw new InitError({ providerID: model.providerID }, { cause: new Error(`Unsupported provider npm package: ${model.api.npm}. Only bundled providers are supported.`) })
      } catch (e) {
        throw new InitError({ providerID: model.providerID }, { cause: e })
      }
    }

    private async init(context: AgentContext) {
      using _ = log.time("state")
      const config = context.config
      const modelsDev = await ModelsDev.get(context)
      const database = mapValues(modelsDev, fromModelsDevProvider)

      const disabled = new Set(config.disabled_providers ?? [])
      const enabled = config.enabled_providers ? new Set(config.enabled_providers) : null

      function isProviderAllowed(providerID: ProviderID): boolean {
        if (enabled && !enabled.has(providerID)) return false
        if (disabled.has(providerID)) return false
        return true
      }

      const providers: { [providerID: string]: Info } = {}
      const languages = new Map<string, LanguageModelV2>()
      const modelLoaders: {
        [providerID: string]: ProviderModelLoader
      } = {}
      const varsLoaders: {
        [providerID: string]: ProviderVarsLoader
      } = {}
      const sdk = new Map<string, SDK>()

      log.info("init")

      const configProviders = Object.entries(config.provider ?? {})


      function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
        const existing = providers[providerID]
        if (existing) {
          providers[providerID] = mergeDeep(existing, provider)
          return
        }
        const match = database[providerID]
        if (!match) return
        providers[providerID] = mergeDeep(match, provider)
      }

      // extend database from config
      for (const [providerID, _provider] of configProviders) {
        const provider = _provider as any
        const existing = database[providerID]
        const parsed: Info = {
          id: ProviderID.make(providerID),
          name: provider.name ?? existing?.name ?? providerID,
          env: provider.env ?? existing?.env ?? [],
          options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
          source: "config",
          models: existing?.models ?? {},
        }

        for (const [modelID, _model] of Object.entries(provider.models ?? {})) {
          const model = _model as any
          const existingModel = parsed.models[model.id ?? modelID]
          const name = iife(() => {
            if (model.name) return model.name
            if (model.id && model.id !== modelID) return modelID
            return existingModel?.name ?? modelID
          })
          const parsedModel: Model = {
            id: ModelID.make(modelID),
            api: {
              id: model.id ?? existingModel?.api.id ?? modelID,
              npm:
                model.provider?.npm ??
                provider.npm ??
                existingModel?.api.npm ??
                modelsDev[providerID]?.npm ??
                "@ai-sdk/openai-compatible",
              url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
            },
            status: model.status ?? existingModel?.status ?? "active",
            name,
            providerID: ProviderID.make(providerID),
            capabilities: {
              temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
              // Always true: safe for non-thinking models, required for thinking models.
              reasoning: true,
              attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
              toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
              input: {
                text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
              },
              output: {
                text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                audio: model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                image: model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                video: model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
              },
              interleaved: model.interleaved ?? false,
            },
            cost: {
              input: model?.cost?.input ?? existingModel?.cost?.input ?? 0,
              output: model?.cost?.output ?? existingModel?.cost?.output ?? 0,
              cache: {
                read: model?.cost?.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                write: model?.cost?.cache_write ?? existingModel?.cost?.cache.write ?? 0,
              },
            },
            options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
            limit: {
              context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
              output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
            },
            headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
            family: model.family ?? existingModel?.family ?? "",
            release_date: model.release_date ?? existingModel?.release_date ?? "",
            variants: {},
          }
          parsed.models[modelID] = parsedModel
        }
        database[providerID] = parsed
      }

      // load env
      const env = context.env.all()
      for (const [id, provider] of Object.entries(database)) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        const apiKey = provider.env.map((item) => env[item]).find(Boolean)
        if (!apiKey) continue
        mergeProvider(providerID, {
          source: "env",
          key: provider.env.length === 1 ? apiKey : undefined,
        })
      }

      // load apikeys
      for (const [id, provider] of Object.entries(await Auth.all())) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        if (provider.type === "api") {
          mergeProvider(providerID, {
            source: "api",
            key: provider.key,
          })
        }
      }



      for (const [id, fn] of Object.entries(VendorRegistry.getModelProvider().getCustomLoaders())) {
        const providerID = ProviderID.make(id)
        if (disabled.has(providerID)) continue
        const data = database[providerID]
        if (!data) {
          log.error("Provider does not exist in model list " + providerID)
          continue
        }
        const result = (await fn(context, data)) as ProviderLoaderResult
        if (result && (result.autoload || providers[providerID])) {
          if (result.getModel) modelLoaders[providerID] = result.getModel
          if (result.vars) varsLoaders[providerID] = result.vars
          const opts = result.options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }
      }

      // load config
      for (const [id, _provider] of configProviders) {
        const provider = _provider as any
        const providerID = ProviderID.make(id)
        const partial: Partial<Info> = { source: "config" }
        if (provider.env) partial.env = provider.env
        if (provider.name) partial.name = provider.name
        if (provider.options) partial.options = provider.options
        mergeProvider(providerID, partial)
      }

      for (const [id, provider] of Object.entries(providers)) {
        const providerID = ProviderID.make(id)
        if (!isProviderAllowed(providerID)) {
          delete providers[providerID]
          continue
        }

        const configProvider = config.provider?.[providerID]

        for (const [modelID, model] of Object.entries(provider.models)) {
          model.api.id = model.api.id ?? model.id ?? modelID
          if (modelID === "gpt-5-chat-latest")
            delete provider.models[modelID]
          if (model.status === "alpha" && !Flag.OPENCODE_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
          if (model.status === "deprecated") delete provider.models[modelID]
          if (
            (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
            (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
          )
            delete provider.models[modelID]

        }

        if (Object.keys(provider.models).length === 0) {
          delete providers[providerID]
          continue
        }

        log.info("found", { providerID })
      }

      return {
        models: languages,
        providers,
        sdk,
        modelLoaders,
        varsLoaders,
      }
    }
  }

  const priority = ["claude", "gpt", "gemini"]

  export function sort<T extends { id: string }>(models: T[]) {
    return sortBy(
      models,
      [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
      [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
      [(model) => model.id, "desc"],
    )
  }

  export function parseModel(model: string) {
    const [providerID, ...rest] = model.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(rest.join("/")),
    }
  }

  export const ModelNotFoundError = NamedError.create(
    "ProviderModelNotFoundError",
    z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      suggestions: z.array(z.string()).optional(),
    }),
  )

  export const InitError = NamedError.create(
    "ProviderInitError",
    z.object({
      providerID: ProviderID.zod,
    }),
  )
}
