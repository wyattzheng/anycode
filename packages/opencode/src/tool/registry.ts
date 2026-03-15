import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import type { AgentContext } from "../agent/context"

import path from "path"
import z from "zod"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/util/flag"
import { Log } from "@/util/log"
import { Truncate } from "./truncation"

import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"

// Inline type definitions (was in util/plugin.ts)
type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  directory: string
  worktree: string
  abort: AbortSignal
  metadata(input: { title?: string; metadata?: { [key: string]: any } }): void
  ask(input: { permission: string; patterns: string[]; always: string[]; metadata: { [key: string]: any } }): Promise<void>
}

type ToolDefinition = {
  description: string
  args: z.ZodRawShape
  execute(args: any, context: ToolContext): Promise<string>
}

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  /**
   * ToolRegistryService — caches resolved tool list.
   */
  export class ToolRegistryService {
    readonly _promise: ReturnType<typeof initTools>
    private context: AgentContext

    constructor(context: AgentContext) {
      this.context = context
      this._promise = initTools(context)
    }

    async register(tool: Tool.Info): Promise<void> {
      const { custom } = await this._promise
      const idx = custom.findIndex((t) => t.id === tool.id)
      if (idx >= 0) {
        custom.splice(idx, 1, tool)
        return
      }
      custom.push(tool)
    }

    async tools(
      model: { providerID: ProviderID; modelID: ModelID },
      agent?: Agent.Info,
    ) {
      return ToolRegistry.tools(this.context, model, agent)
    }
  }

  async function initTools(context: AgentContext) {
    const custom = [] as Tool.Info[]
    return { custom }
  }

  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),
        description: def.description,
        execute: async (args, ctx) => {
          const pluginCtx = {
            ...ctx,
            directory: ctx.directory,
            worktree: ctx.worktree,
          } as unknown as ToolContext
          const result = await def.execute(args as any, pluginCtx)
          const out = await Truncate.output(ctx as any, result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  async function all(context: AgentContext): Promise<Tool.Info[]> {
    const custom = await context.toolRegistry._promise.then((x) => x.custom)
    const config = context.config
    const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

    return [
      InvalidTool,
      ...(question ? [QuestionTool] : []),
      BashTool,
      ReadTool,
      GlobTool,
      GrepTool,
      EditTool,
      WriteTool,
      WebFetchTool,
      TodoWriteTool,
      // TodoReadTool,
      WebSearchTool,
      CodeSearchTool,
      SkillTool,
      ApplyPatchTool,
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
      ...custom,
    ]
  }

  export async function ids(context: AgentContext) {
    return all(context).then((x) => x.map((t) => t.id))
  }

  export async function tools(
    context: AgentContext,
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
    agent?: Agent.Info,
  ) {
    const tools = await all(context)
    const result = await Promise.all(
      tools
        .filter((t) => {
          // Enable websearch/codesearch for zen users OR via enable flag
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
          }

          // use apply tool in same format as codex
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)
          const tool = await t.init({ agent, agentContext: context })
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          return {
            id: t.id,
            ...tool,
            description: output.description,
            parameters: output.parameters,
          }
        }),
    )
    return result
  }
}
