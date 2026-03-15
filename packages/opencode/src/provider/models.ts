import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import path from "path"
import z from "zod"
import { Installation } from "../util/installation"
import { Flag } from "../util/flag"
import { Filesystem } from "../util/filesystem"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

export namespace ModelsDev {
  const log = Log.create({ service: "models.dev" })
  export function filepath(context: AgentContext) {
    return path.join(context.paths.cache, "models.json")
  }

  export const Model = z.object({
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
  export type Model = z.infer<typeof Model>

  export const Provider = z.object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), Model),
  })

  export type Provider = z.infer<typeof Provider>

  function url() {
    return Flag.OPENCODE_MODELS_URL || "https://models.dev"
  }

  const STATE_KEY = Symbol("models.dev")
  function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => initModels(context))
  }
  async function initModels(context: AgentContext) {
      let data: Record<string, unknown> | undefined
      try {
        data = await Filesystem.readJson(context, Flag.OPENCODE_MODELS_PATH ?? filepath(context)).catch(() => undefined)
      } catch {}
      if (data) return { data }
      // @ts-ignore
      const snapshot = await import("./models-snapshot")
        .then((m) => m.snapshot as Record<string, unknown>)
        .catch(() => undefined)
      if (snapshot) return { data: snapshot }
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return { data: {} as Record<string, unknown> }
      const json = await fetch(`${url()}/api.json`).then((x) => x.text())
      return { data: JSON.parse(json) as Record<string, unknown> }
    }

  export async function get(context: AgentContext) {
    const s = await state(context)
    return s.data as Record<string, Provider>
  }

  export async function refresh(context: AgentContext) {
    const result = await fetch(`${url()}/api.json`, {
      headers: {
        "User-Agent": Installation.USER_AGENT,
      },
      signal: AbortSignal.timeout(10 * 1000),
    }).catch((e) => {
      log.error("Failed to fetch models.dev", {
        error: e,
      })
    })
    if (result && result.ok) {
      try {
        await Filesystem.write(context, filepath(context), await result.text())
      } catch (e) {
        log.warn("Failed to write models cache", { error: e })
      }
    }
  }
}
