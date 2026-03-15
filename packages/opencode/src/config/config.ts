import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"
import path from "path"
import os from "os"
import z from "zod"
import { ModelsDev } from "../provider/models"
import { mergeDeep, pipe } from "remeda"
import { NamedError } from "@/util/error"
import { Flag } from "../util/flag"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"

import { ConfigMarkdown } from "./markdown"
import { existsSync } from "fs"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { Glob } from "../util/glob"
import { ConfigPaths } from "./paths"
import { Filesystem } from "@/util/filesystem"
export namespace Config {
  const ModelId = z.string().meta({ $ref: "https://models.dev/model-schema.json#/$defs/Model" })
  const log = Log.create({ service: "config" })

  function rel(item: string, patterns: string[]) {
    const normalizedItem = item.replaceAll("\\", "/")
    for (const pattern of patterns) {
      const index = normalizedItem.indexOf(pattern)
      if (index === -1) continue
      return normalizedItem.slice(index + pattern.length)
    }
  }

  function trim(file: string) {
    const ext = path.extname(file)
    return ext.length ? file.slice(0, -ext.length) : file
  }

  async function loadAgent(context: AgentContext, dir: string) {
    const result: Record<string, Agent> = {}
    for (const item of await Glob.scan(context, "{agent,agents}/**/*.md", {
      cwd: dir,
      absolute: true,
      dot: true,
      symlink: true,
    })) {
      const md = await ConfigMarkdown.parse(context, item).catch(async (err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse agent ${item}`
        const { Session } = await import("@/session")
        Bus.publish(undefined, Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load agent", { agent: item, err })
        return undefined
      })
      if (!md) continue

      const patterns = ["/.opencode/agent/", "/.opencode/agents/", "/agent/", "/agents/"]
      const file = rel(item, patterns) ?? path.basename(item)
      const agentName = trim(file)

      const config = {
        name: agentName,
        ...md.data,
        prompt: md.content.trim(),
      }
      const parsed = Agent.safeParse(config)
      if (parsed.success) {
        result[config.name] = parsed.data
        continue
      }
      throw new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    }
    return result
  }



  /**
   * ConfigService — caches the resolved configuration for this agent instance.
   */
  export class ConfigService {
    readonly _promise: Promise<{ config: Info; directories: string[]; deps: Promise<void>[] }>

    constructor(context: AgentContext) {
      this._promise = initConfig(context)
    }

    async get(): Promise<Info> {
      return (await this._promise).config
    }

    async directories(): Promise<string[]> {
      return (await this._promise).directories
    }

    async waitForDependencies(): Promise<void> {
      const deps = (await this._promise).deps
      await Promise.all(deps)
    }
  }

  async function initConfig(context: AgentContext) {
    // Short-circuit: if config was injected via Instance context
    const injected = context.configOverrides
    if (injected) {
      return {
        config: injected as Info,
        directories: [] as string[],
        deps: [] as Promise<void>[],
      }
    }

    let result: Info = {}

    // Global config
    result = mergeDeep(result, await globalConfig(context)) as Info

    // Custom config path
    if (Flag.OPENCODE_CONFIG) {
      result = mergeDeep(result, await loadFile(context, Flag.OPENCODE_CONFIG)) as Info
    }

    // Project config
    if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
      for (const file of await ConfigPaths.projectFiles(context, "opencode", context.directory, context.worktree)) {
        result = mergeDeep(result, await loadFile(context, file)) as Info
      }
    }

    result.agent = result.agent || {}

    const directories = await ConfigPaths.directories(context, context.directory, context.worktree)

    // .opencode directory config
    for (const dir of directories) {
      if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
        for (const file of ["opencode.jsonc", "opencode.json"]) {
          result = mergeDeep(result, await loadFile(context, path.join(dir, file))) as Info
          result.agent ??= {}
        }
      }
      result.agent = mergeDeep(result.agent, await loadAgent(context, dir))
    }

    // Inline config content
    if (process.env.OPENCODE_CONFIG_CONTENT) {
      result = mergeDeep(
        result,
        await load(context, process.env.OPENCODE_CONFIG_CONTENT, {
          dir: context.directory,
          source: "OPENCODE_CONFIG_CONTENT",
        }),
      ) as Info
    }



    if (!result.username) result.username = os.userInfo().username

    // Apply flag overrides for compaction settings
    if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
      result.compaction = { ...result.compaction, auto: false }
    }
    if (Flag.OPENCODE_DISABLE_PRUNE) {
      result.compaction = { ...result.compaction, prune: false }
    }

    return {
      config: result,
      directories,
      deps: [] as Promise<void>[],
    }
  }



  export const McpLocal = z
    .object({
      type: z.literal("local").describe("Type of MCP server connection"),
      command: z.string().array().describe("Command and arguments to run the MCP server"),
      environment: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set when running the MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpLocalConfig",
    })

  export const McpOAuth = z
    .object({
      clientId: z
        .string()
        .optional()
        .describe("OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted."),
      clientSecret: z.string().optional().describe("OAuth client secret (if required by the authorization server)"),
      scope: z.string().optional().describe("OAuth scopes to request during authorization"),
    })
    .strict()
    .meta({
      ref: "McpOAuthConfig",
    })
  export type McpOAuth = z.infer<typeof McpOAuth>

  export const McpRemote = z
    .object({
      type: z.literal("remote").describe("Type of MCP server connection"),
      url: z.string().describe("URL of the remote MCP server"),
      enabled: z.boolean().optional().describe("Enable or disable the MCP server on startup"),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to send with the request"),
      oauth: z
        .union([McpOAuth, z.literal(false)])
        .optional()
        .describe(
          "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
        ),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
    })
    .strict()
    .meta({
      ref: "McpRemoteConfig",
    })

  export const Mcp = z.discriminatedUnion("type", [McpLocal, McpRemote])
  export type Mcp = z.infer<typeof Mcp>


  export const Skills = z.object({
    paths: z.array(z.string()).optional().describe("Additional paths to skill folders"),
    urls: z
      .array(z.string())
      .optional()
      .describe("URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)"),
  })
  export type Skills = z.infer<typeof Skills>

  export const Agent = z
    .object({
      model: ModelId.optional(),
      variant: z
        .string()
        .optional()
        .describe("Default model variant for this agent (applies only when using the agent's configured model)."),
      temperature: z.number().optional(),
      top_p: z.number().optional(),
      prompt: z.string().optional(),
      tools: z.record(z.string(), z.boolean()).optional(),
      disable: z.boolean().optional(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]).optional(),
      hidden: z.boolean().optional(),
      options: z.record(z.string(), z.any()).optional(),
      color: z
        .union([
          z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color format"),
          z.enum(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
        ])
        .optional(),
      steps: z.number().int().positive().optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .catchall(z.any())
    .transform((agent) => {
      const knownKeys = new Set([
        "name", "model", "variant", "prompt", "description", "temperature", "top_p",
        "mode", "hidden", "color", "steps", "maxSteps", "options", "disable", "tools",
      ])

      const options: Record<string, unknown> = { ...agent.options }
      for (const [key, value] of Object.entries(agent)) {
        if (!knownKeys.has(key)) options[key] = value
      }

      const steps = agent.steps ?? agent.maxSteps

      return { ...agent, options, steps } as typeof agent & {
        options?: Record<string, unknown>
        steps?: number
      }
    })
    .meta({
      ref: "AgentConfig",
    })
  export type Agent = z.infer<typeof Agent>



  export const Provider = ModelsDev.Provider.partial()
    .extend({
      whitelist: z.array(z.string()).optional(),
      blacklist: z.array(z.string()).optional(),
      models: z
        .record(
          z.string(),
          ModelsDev.Model.partial().extend({
            variants: z
              .record(
                z.string(),
                z
                  .object({
                    disabled: z.boolean().optional().describe("Disable this variant for the model"),
                  })
                  .catchall(z.any()),
              )
              .optional()
              .describe("Variant-specific configuration"),
          }),
        )
        .optional(),
      options: z
        .object({
          apiKey: z.string().optional(),
          baseURL: z.string().optional(),
          enterpriseUrl: z.string().optional().describe("GitHub Enterprise URL for copilot authentication"),
          setCacheKey: z.boolean().optional().describe("Enable promptCacheKey for this provider (default false)"),
          timeout: z
            .union([
              z
                .number()
                .int()
                .positive()
                .describe(
                  "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
                ),
              z.literal(false).describe("Disable timeout for this provider entirely."),
            ])
            .optional()
            .describe(
              "Timeout in milliseconds for requests to this provider. Default is 300000 (5 minutes). Set to false to disable timeout.",
            ),
          chunkTimeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Timeout in milliseconds between streamed SSE chunks for this provider. If no chunk arrives within this window, the request is aborted.",
            ),
        })
        .catchall(z.any())
        .optional(),
    })
    .strict()
    .meta({
      ref: "ProviderConfig",
    })
  export type Provider = z.infer<typeof Provider>

  export const Info = z
    .object({
      $schema: z.string().optional(),
      logLevel: Log.Level.optional(),
      skills: Skills.optional(),
      watcher: z
        .object({
          ignore: z.array(z.string()).optional(),
        })
        .optional(),
      disabled_providers: z.array(z.string()).optional(),
      enabled_providers: z.array(z.string()).optional(),
      model: ModelId.optional(),
      small_model: ModelId.optional(),
      default_agent: z.string().optional(),
      username: z.string().optional(),
      agent: z
        .object({
          plan: Agent.optional(),
          build: Agent.optional(),
          general: Agent.optional(),
          explore: Agent.optional(),
          title: Agent.optional(),
          summary: Agent.optional(),
          compaction: Agent.optional(),
        })
        .catchall(Agent)
        .optional(),
      provider: z.record(z.string(), Provider).optional(),
      mcp: z
        .record(
          z.string(),
          z.union([
            Mcp,
            z.object({ enabled: z.boolean() }).strict(),
          ]),
        )
        .optional(),
      instructions: z.array(z.string()).optional(),
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          reserved: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
        })
        .optional(),
      experimental: z
        .object({
          disable_paste_summary: z.boolean().optional(),
          batch_tool: z.boolean().optional().describe("Enable the batch tool"),
          openTelemetry: z
            .boolean()
            .optional()
            .describe("Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)"),
          primary_tools: z
            .array(z.string())
            .optional()
            .describe("Tools that should only be available to primary agents."),
          continue_loop_on_deny: z.boolean().optional().describe("Continue the agent loop when a tool call is denied"),
          mcp_timeout: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in milliseconds for model context protocol (MCP) requests"),
        })
        .optional(),
    })
    .strict()
    .meta({
      ref: "Config",
    })

  export type Info = z.output<typeof Info>

  async function globalConfig(context: AgentContext) {
    return pipe(
      {},
      mergeDeep(await loadFile(context, path.join(context.paths.config, "config.json"))),
      mergeDeep(await loadFile(context, path.join(context.paths.config, "opencode.json"))),
      mergeDeep(await loadFile(context, path.join(context.paths.config, "opencode.jsonc"))),
    )
  }

  async function loadFile(context: AgentContext, filepath: string): Promise<Info> {
    log.info("loading", { path: filepath })
    const text = await ConfigPaths.readFile(context, filepath)
    if (!text) return {}
    return load(context, text, { path: filepath })
  }

  async function load(context: AgentContext, text: string, options: { path: string } | { dir: string; source: string }) {
    const original = text
    const source = "path" in options ? options.path : options.source
    const isFile = "path" in options
    const data = await ConfigPaths.parseText(context,
      text,
      "path" in options ? options.path : { source: options.source, dir: options.dir },
    )

    const normalized = (() => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return data
      const copy = { ...(data as Record<string, unknown>) }
      // Strip legacy TUI keys
      delete copy.theme
      delete copy.keybinds
      delete copy.tui
      return copy
    })()

    const parsed = Info.safeParse(normalized)
    if (parsed.success) {
      if (!parsed.data.$schema && isFile) {
        parsed.data.$schema = "https://opencode.ai/config.json"
        const updated = original.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        await Filesystem.write(context, options.path, updated).catch(() => { })
      }
      return parsed.data
    }

    throw new InvalidError({
      path: source,
      issues: parsed.error.issues,
    })
  }
  export const { JsonError, InvalidError } = ConfigPaths

  export const ConfigDirectoryTypoError = NamedError.create(
    "ConfigDirectoryTypoError",
    z.object({
      path: z.string(),
      dir: z.string(),
      suggestion: z.string(),
    }),
  )

  export async function get(context: AgentContext) {
    return context.config._promise.then((x) => x.config)
  }

  export async function getGlobal(context: AgentContext) {
    return globalConfig(context)
  }

  export async function update(context: AgentContext, config: Info) {
    const filepath = path.join(context.directory, "config.json")
    const existing = await loadFile(context, filepath)
    await Filesystem.writeJson(context, filepath, mergeDeep(existing, config))
    // TODO: implement dispose via context
  }

  function globalConfigFile(context: AgentContext) {
    const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((file) =>
      path.join(context.paths.config, file),
    )
    for (const file of candidates) {
      if (existsSync(file)) return file
    }
    return candidates[0]
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
    if (!isRecord(patch)) {
      const edits = modify(input, path, patch, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
        },
      })
      return applyEdits(input, edits)
    }

    return Object.entries(patch).reduce((result, [key, value]) => {
      if (value === undefined) return result
      return patchJsonc(result, value, [...path, key])
    }, input)
  }

  function parseConfig(text: string, filepath: string): Info {
    const errors: JsoncParseError[] = []
    const data = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length) {
      const lines = text.split("\n")
      const errorDetails = errors
        .map((e) => {
          const beforeOffset = text.substring(0, e.offset).split("\n")
          const line = beforeOffset.length
          const column = beforeOffset[beforeOffset.length - 1].length + 1
          const problemLine = lines[line - 1]

          const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
          if (!problemLine) return error

          return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
        })
        .join("\n")

      throw new JsonError({
        path: filepath,
        message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
      })
    }

    const parsed = Info.safeParse(data)
    if (parsed.success) return parsed.data

    throw new InvalidError({
      path: filepath,
      issues: parsed.error.issues,
    })
  }

  export async function updateGlobal(context: AgentContext, config: Info) {
    const filepath = globalConfigFile(context)
    const before = await Filesystem.readText(context, filepath).catch((err: any) => {
      if (err.code === "ENOENT") return "{}"
      throw new JsonError({ path: filepath }, { cause: err })
    })

    const next = await (async () => {
      if (!filepath.endsWith(".jsonc")) {
        const existing = parseConfig(before, filepath)
        const merged = mergeDeep(existing, config)
        await Filesystem.writeJson(context, filepath, merged)
        return merged
      }

      const updated = patchJsonc(before, config)
      const merged = parseConfig(updated, filepath)
      await Filesystem.write(context, filepath, updated)
      return merged
    })()

    // TODO: implement global config reset

    void Promise.resolve()
      .catch(() => undefined)
      .finally(() => {
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: "server.disposed",
            properties: {},
          },
        })
      })

    return next
  }

  export async function directories(context: AgentContext) {
    return context.config._promise.then((x) => x.directories)
  }
}
