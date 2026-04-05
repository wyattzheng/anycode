import z from "zod"
import { Tool } from "@any-code/agent"

const PROJECT_REQUIRED_ERROR = "No watched project is set. Call set_user_watch_project with an absolute project directory before using user_watch_terminal."

const DESCRIPTION = `Send input to the shared user terminal, optionally waiting and reading output.

This tool interacts with a single shared terminal (PTY) that is also visible in the user's UI.
If no terminal exists, one is automatically created on the first call.

## Parameters
- **content**: The text to send to the terminal.
- **pressEnter**: Whether to press Enter after the input. Defaults to true. Set to false for partial input or answering prompts like y/n.
- **reset**: If true, destroy the current terminal and create a fresh one before sending input. Use this when the terminal is stuck or unresponsive.
- **waitMs**: Milliseconds to wait after sending input before reading output. If omitted or 0, no output is read. Maximum 5000ms.
- **readLines**: Number of lines to read from the bottom of the terminal buffer after waiting. Only used when waitMs > 0. Defaults to 50.

## Important
- In most cases, prefer the **bash** tool for running commands. It is faster, captures output directly, and does not require a persistent terminal.
- Use this tool when you need a **persistent, stateful shell session**, e.g. running a long-lived dev server for preview, interactive REPL, or commands that depend on prior shell state.

## Usage notes
- Requires an active watched project. If no project is open in the UI yet, call set_user_watch_project first.
- This is a user-watch terminal: the user can watch the same terminal session in the UI while you use it.
- When answering interactive prompts (e.g. "Continue? [y/n]"), set pressEnter=false if the program reads single characters, or pressEnter=true if it expects a line.
- To just read output without sending new input, omit content and set waitMs/readLines.
`

export const TerminalTool = Tool.define("user_watch_terminal", async () => {
  return {
    description: DESCRIPTION,
    parameters: z.object({
      content: z
        .string()
        .describe("The text to send to the terminal. Omit to just read output without sending input.")
        .optional(),
      pressEnter: z
        .preprocess((v) => v === "true" || v === true, z.boolean())
        .describe("Whether to press Enter after the input. Defaults to true.")
        .optional(),
      reset: z
        .preprocess((v) => v === "true" || v === true, z.boolean())
        .describe("If true, destroy and recreate the terminal before sending input. Use when the terminal is stuck.")
        .optional(),
      waitMs: z.coerce
        .number()
        .int()
        .min(0)
        .describe("Milliseconds to wait after sending input before reading output. If 0 or omitted, no output is read. Max 5000.")
        .optional(),
      readLines: z.coerce
        .number()
        .int()
        .min(1)
        .describe("Number of lines to read from the bottom after waiting. Only used when waitMs > 0. Defaults to 50.")
        .optional(),
    }),
    async execute(params, ctx) {
      const worktree = typeof ctx.worktree === "string" ? ctx.worktree.trim() : ""
      if (!worktree) throw new Error(PROJECT_REQUIRED_ERROR)

      const terminal = ctx.terminal

      // Ensure terminal is running (auto-create if needed, reset if requested)
      terminal.ensureRunning(params.reset)

      // Send input (only if content provided)
      if (params.content != null && params.content !== "") {
        const pressEnter = params.pressEnter ?? true
        const data = pressEnter ? params.content + "\n" : params.content
        terminal.write(data)
      }

      // Optionally wait and read
      const MAX_WAIT = 5000
      const waitMs = Math.min(params.waitMs ?? 0, MAX_WAIT)
      let output = params.content ? "Input sent to terminal." : "(no input sent)"

      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        const readLines = params.readLines ?? 50
        const content = terminal.read(readLines)
        output = content || "(terminal buffer is empty)"
      }

      const label = params.content || "(read)"
      const title = params.reset
        ? "Reset terminal & " + (label.length > 40 ? label.slice(0, 37) + "..." : label)
        : label.length > 60 ? label.slice(0, 57) + "..." : label

      return {
        title,
        metadata: {
          content: params.content,
          pressEnter: params.pressEnter ?? true,
          reset: params.reset ?? false,
          waitMs,
          readLines: params.readLines,
        },
        output,
      } as any
    },
  }
})
