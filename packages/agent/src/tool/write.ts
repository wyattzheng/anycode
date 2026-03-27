import z from "zod"
import * as path from "../util/path"
import { Tool } from "./tool"

import { createTwoFilesPatch } from "diff"
const DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.
`


import { trimDiff } from "./edit"
import { assertExternalDirectory } from "./external-directory"

export const WriteTool = Tool.define("write", {
  description: DESCRIPTION,
  parameters: z.object({
    content: z.string().describe("The content to write to the file"),
    filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
  }),
  async execute(params, ctx) {
    const filepath = path.isAbsolute(params.filePath) ? params.filePath : path.join(ctx.directory, params.filePath)
    await assertExternalDirectory(ctx, filepath)

    const exists = await ctx.fs.exists(filepath)
    const contentOld = exists ? await ctx.fs.readText(filepath) : ""
    if (exists) await ctx.fileTime.assert(ctx, ctx.sessionID, filepath)

    const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(ctx.worktree, filepath)],
      always: ["*"],
      metadata: {
        filepath,
        diff,
      },
    })

    await ctx.fs.write(filepath, params.content)
    ctx.emit("file.edited", { file: filepath })

    ctx.fileTime.read(ctx.sessionID, filepath)

    const output = "Wrote file successfully."

    return {
      title: path.relative(ctx.worktree, filepath),
      metadata: {
        diagnostics: {},
        filepath,
        exists: exists,
      },
      output,
    }
  },
})
