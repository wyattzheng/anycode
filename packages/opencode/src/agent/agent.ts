import type { AgentContext } from "@/agent/context"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session"
import { Truncate } from "../tool/truncation"
import { Auth } from "../util/auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"

import { mergeDeep, pipe, sortBy, values } from "remeda"
import path from "path"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),

      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  /**
   * AgentService — caches resolved agent definitions.
   */
  export class AgentService {
    readonly _promise: Promise<Record<string, Info>>
    private context: AgentContext

    constructor(context: AgentContext) {
      this.context = context
      this._promise = this.initAgents()
    }

    async get(name: string): Promise<Info | undefined> {
      return (await this._promise)[name]
    }

    async list(): Promise<Record<string, Info>> {
      return this._promise
    }

    /** Returns a sorted array of agents (default agent first, then alphabetical) */
    async listSorted(): Promise<Info[]> {
      const cfg = this.context.config
      return pipe(
        await this._promise,
        values(),
        sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
      )
    }

    /** Returns the name of the default agent */
    async defaultAgent(): Promise<string> {
      const cfg = this.context.config
      const agents = await this._promise

      if (cfg.default_agent) {
        const agent = agents[cfg.default_agent]
        if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
        if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
        if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
        return agent.name
      }

      const primaryVisible = Object.values(agents).find((a: Info) => a.mode !== "subagent" && a.hidden !== true)
      if (!primaryVisible) throw new Error("no primary visible agent found")
      return primaryVisible.name
    }

    /** Generate a new agent configuration from description */
    async generate(input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }> {
      const cfg = this.context.config
      const defaultModel = input.model ?? (await this.context.provider.defaultModel())
      const model = await this.context.provider.getModel(defaultModel.providerID, defaultModel.modelID)
      const language = await this.context.provider.getLanguage(model)

      const system = [PROMPT_GENERATE]
      const existing = await this.listSorted()

      const params = {
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          metadata: {
            userId: cfg.username ?? "unknown",
          },
        },
        temperature: 0.3,
        messages: [
          ...system.map(
            (item): ModelMessage => ({
              role: "system",
              content: item,
            }),
          ),
          {
            role: "user",
            content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
          },
        ],
        model: language,
        schema: z.object({
          identifier: z.string(),
          whenToUse: z.string(),
          systemPrompt: z.string(),
        }),
      } satisfies Parameters<typeof generateObject>[0]

      if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
        const result = streamObject({
          ...params,
          providerOptions: ProviderTransform.providerOptions(model, {
            instructions: SystemPrompt.instructions(),
            store: false,
          }),
          onError: () => {},
        })
        for await (const part of result.fullStream) {
          if (part.type === "error") throw part.error
        }
        return result.object
      }

      const result = await generateObject(params)
      return result.object
    }

    private async initAgents(): Promise<Record<string, Info>> {
      const context = this.context
      const cfg = context.config

      const result: Record<string, Info> = {
        build: {
          name: "build",
          description: "The default agent.",
          options: {},
          mode: "primary",
          native: true,
        },
        plan: {
          name: "plan",
          description: "Plan mode. Disallows all edit tools.",
          options: {},
          mode: "primary",
          native: true,
        },
        general: {
          name: "general",
          description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
          options: {},
          mode: "subagent",
          native: true,
        },
        explore: {
          name: "explore",
          description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
          prompt: PROMPT_EXPLORE,
          options: {},
          mode: "subagent",
          native: true,
        },
        compaction: {
          name: "compaction",
          mode: "primary",
          native: true,
          hidden: true,
          prompt: PROMPT_COMPACTION,
          options: {},
        },
        title: {
          name: "title",
          mode: "primary",
          options: {},
          native: true,
          hidden: true,
          temperature: 0.5,
          prompt: PROMPT_TITLE,
        },
        summary: {
          name: "summary",
          mode: "primary",
          options: {},
          native: true,
          hidden: true,
          prompt: PROMPT_SUMMARY,
        },
      }

      for (const [key, value] of Object.entries(cfg.agent ?? {})) {
        if (value.disable) {
          delete result[key]
          continue
        }
        let item = result[key]
        if (!item)
          item = result[key] = {
            name: key,
            mode: "all",
            options: {},
            native: false,
          }
        if (value.model) item.model = Provider.parseModel(value.model)
        item.variant = value.variant ?? item.variant
        item.prompt = value.prompt ?? item.prompt
        item.description = value.description ?? item.description
        item.temperature = value.temperature ?? item.temperature
        item.topP = value.top_p ?? item.topP
        item.mode = value.mode ?? item.mode
        item.color = value.color ?? item.color
        item.hidden = value.hidden ?? item.hidden
        item.name = value.name ?? item.name
        item.steps = value.steps ?? item.steps
        item.options = mergeDeep(item.options, value.options ?? {})
      }

      return result
    }
  }
}
