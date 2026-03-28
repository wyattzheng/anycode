import z from "zod"
import * as path from "../util/path"
import { Tool } from "./tool"

const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.
`
import { assertExternalDirectory } from "./external-directory"

export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "glob",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    let search = params.path ?? ctx.directory
    search = path.isAbsolute(search) ? search : path.resolve(ctx.directory, search)
    await assertExternalDirectory(ctx, search, { kind: "directory" })

    const limit = 100
    if (!ctx.search) throw new Error("Search is not available.")

    const filePaths = await ctx.search.listFiles({
      cwd: search,
      glob: [params.pattern],
      limit: limit + 1, // +1 to detect truncation
      signal: ctx.abort,
    })

    const truncated = filePaths.length > limit
    const displayPaths = truncated ? filePaths.slice(0, limit) : filePaths

    const files = []
    for (const file of displayPaths) {
      const full = path.resolve(search, file)
      const s = await ctx.fs.stat(full)
      const stats = s?.mtimeMs ?? 0
      files.push({
        path: full,
        mtime: stats,
      })
    }
    files.sort((a, b) => b.mtime - a.mtime)

    const output = []
    if (files.length === 0) output.push("No files found")
    if (files.length > 0) {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push("")
        output.push(
          `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
        )
      }
    }

    return {
      title: params.pattern,
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})
