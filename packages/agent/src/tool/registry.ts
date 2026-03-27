import { PlanExitTool } from "./plan"
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


import { Tool } from "./tool"
import type { AgentContext } from "../context"

import * as path from "../util/path"
import z from "zod"
import { ProviderID, type ModelID } from "@any-code/provider"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "../util/flag"
import { Truncate } from "./truncation"

import { ApplyPatchTool } from "./apply_patch"
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

// ── Interface ─────────────────────────────────────────────────────────

export interface IToolRegistryService {
  register(tool: Tool.Info): Promise<void>
  ids(): Promise<string[]>
  tools(model: { providerID: ProviderID; modelID: ModelID }): Promise<any[]>
}

// ── ToolRegistryService ───────────────────────────────────────────────

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
        const out = await Truncate.output(ctx as any, result, {})
        return {
          title: "",
          output: out.truncated ? out.content : result,
          metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
        }
      },
    }),
  }
}

export class ToolRegistryService implements IToolRegistryService {
  private readonly _custom: Tool.Info[] = []
  private readonly context: AgentContext

  constructor(context: AgentContext) {
    this.context = context
  }

  async register(tool: Tool.Info): Promise<void> {
    const idx = this._custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      this._custom.splice(idx, 1, tool)
      return
    }
    this._custom.push(tool)
  }

  private all(): Tool.Info[] {
    const config = this.context.config
    return [
      InvalidTool,
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

      ApplyPatchTool,
      ...(this.context.tools ?? []),
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),
      ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
      ...this._custom,
    ]
  }

  async ids(): Promise<string[]> {
    return this.all().map((t) => t.id)
  }

  async tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
    },
  ) {
    const tools = this.all()
    const context = this.context
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
          using _ = context.log.create({ service: "tool.registry" }).time(t.id)
          const tool = await t.init({ agentContext: context })
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
