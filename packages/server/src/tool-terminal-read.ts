import z from "zod"
import { Tool } from "@any-code/agent"
const DESCRIPTION = `Read the terminal output from the bottom of the buffer.

Returns the last N lines from the shared user terminal. Use this after sending a command via terminal_write to see its output.

## Parameters
- **length**: How many lines to read from the bottom. Start with a small number (e.g. 20-50) and increase if you need more context.
- **waitBefore**: Milliseconds to wait before reading. Use this to let a command finish producing output. Defaults to 0. Maximum is 5000ms (values above 5000 are clamped to 5000).

## Important
- In most cases, prefer the **bash** tool for running commands — it captures output directly without needing terminal_read.
- Use terminal_read when reading output from a persistent terminal session (e.g. a dev server for preview) started via terminal_write.

## Usage notes
- If no terminal exists, this tool returns an error. Use terminal_write first to create one.
- If output looks truncated or the command hasn't finished, just call terminal_read again — the terminal is persistent.
- Lines are returned as plain text, one per line.
`

export const TerminalReadTool = Tool.define("terminal_read", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      length: z
        .number()
        .int()
        .min(1)
        .describe("Number of lines to read from the bottom of the terminal buffer."),
      waitBefore: z
        .number()
        .int()
        .min(0)
        .describe("Milliseconds to wait before reading. Use this to let a command finish producing output. Defaults to 0.")
        .optional(),
    }),
    async execute(params, ctx) {
      const terminal = ctx.terminal

      if (!terminal.exists()) {
        throw new Error("No terminal exists. Use terminal_write first.")
      }

      const MAX_WAIT = 5000
      const waitMs = Math.min(params.waitBefore ?? 0, MAX_WAIT)
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }

      const content = terminal.read(params.length)

      return {
        title: `Read ${params.length} lines`,
        metadata: {
          length: params.length,
          waitBefore: waitMs,
        },
        output: content || "(terminal buffer is empty)",
      }
    },
  }
})
