import z from "zod"
import { text } from "node:stream/consumers"
import { Tool } from "./tool"

import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: "Searches for a regex pattern in file contents within the current workspace.",
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const matches = await Instance.search.grep({
      pattern: params.pattern,
      path: searchPath,
      include: params.include,
      maxLineLength: MAX_LINE_LENGTH,
      signal: ctx.abort
    })

    if (matches.length === 0) {
      return {
        title: "grep",
        metadata: {
          count: 0,
          files: 0,
          truncated: false,
        },
        output: "No results matched the specified pattern",
      }
    }

    const totalMatches = matches.length
    const resultLimit = 100
    let filesCount = 0
    let fileMatches: { file: string, lines: typeof matches }[] = []
    let currentFile = ""
    let currentLines: typeof matches = []

    for (const match of matches) {
      if (match.file !== currentFile) {
        if (currentFile) {
          fileMatches.push({ file: currentFile, lines: currentLines })
          filesCount++
        }
        currentFile = match.file
        currentLines = []
        if (filesCount >= resultLimit) break
      }
      currentLines.push(match)
    }
    if (currentFile && filesCount < resultLimit) {
      fileMatches.push({ file: currentFile, lines: currentLines })
      filesCount++
    }

    const truncated = filesCount >= resultLimit

    fileMatches.sort((a, b) => b.lines.length - a.lines.length)
    if (fileMatches.length > 10) {
      fileMatches = fileMatches.slice(0, 10)
    }

    const output: string[] = []
    if (filesCount > 10) {
      output.push(
        `(Showing top 10 files by number of matches. There are ${filesCount} files in total that match the pattern.)`,
        "",
      )
    }

    for (const fm of fileMatches) {
      const matchLimit = 15
      output.push(`[${path.relative(Instance.worktree, fm.file)}]`)
      for (const match of fm.lines.slice(0, matchLimit)) {
        output.push(`  ${match.line}: ${match.content}`)
      }
      if (fm.lines.length > matchLimit) {
        output.push(`  ... (${fm.lines.length - matchLimit} more matches in this file)`)
      }
      output.push("")
    }

    if (truncated) {
      output.push(`...`)
      output.push(`(Results have been truncated to the first ${resultLimit} files matched)`)
    }

    return {
      title: "grep",
      metadata: {
        count: matches.length,
        files: filesCount,
        truncated,
      },
      output: output.join("\n"),
    }
  },
})
