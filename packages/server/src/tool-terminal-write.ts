import z from "zod"
import { Tool } from "@any-code/agent"
const DESCRIPTION = `Send input to the shared user terminal.

This tool interacts with a single shared terminal (PTY) that is also visible to the user.
If no terminal exists, one is automatically created on the first call.

## Parameters
- **content**: The text to send to the terminal.
- **pressEnter**: Whether to press Enter after the input. Defaults to true. Set to false for partial input or answering prompts like y/n.
- **reset**: If true, destroy the current terminal and create a fresh one before sending input. Use this when the terminal is stuck or unresponsive.

## Important
- In most cases, prefer the **bash** tool for running commands. It is faster, captures output directly, and does not require a persistent terminal.
- Use terminal_write/terminal_read when you need a **persistent, stateful shell session**, e.g. running a long-lived dev server for preview, interactive REPL, or commands that depend on prior shell state.

## Usage notes
- The terminal is shared with the user — they can see everything you type and you can see their output.
- For commands that produce output, use the terminal_read tool after sending input to see the results.
- When answering interactive prompts (e.g. "Continue? [y/n]"), set pressEnter=false if the program reads single characters, or pressEnter=true if it expects a line.
`

export const TerminalWriteTool = Tool.define("terminal_write", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      content: z
        .string()
        .describe("The text to send to the terminal."),
      pressEnter: z
        .boolean()
        .describe("Whether to press Enter after the input. Defaults to true.")
        .optional(),
      reset: z
        .boolean()
        .describe("If true, destroy and recreate the terminal before sending input. Use when the terminal is stuck or unresponsive.")
        .optional(),
    }),
    async execute(params, ctx) {
      const terminal = ctx.terminal

      // Ensure terminal is running (auto-create if needed, reset if requested)
      terminal.ensureRunning(params.reset)

      const pressEnter = params.pressEnter ?? true
      const data = pressEnter ? params.content + "\n" : params.content
      terminal.write(data)

      const title = params.reset
        ? "Reset terminal & " + (params.content.length > 40 ? params.content.slice(0, 37) + "..." : params.content)
        : params.content.length > 60 ? params.content.slice(0, 57) + "..." : params.content

      return {
        title,
        metadata: {
          content: params.content,
          pressEnter,
          reset: params.reset ?? false,
        },
        output: `Input sent to terminal.`,
      } as any
    },
  }
})
