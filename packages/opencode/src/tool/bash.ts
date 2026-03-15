import z from "zod"
import { Tool } from "./tool"
import * as path from "../util/path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"

import { Filesystem } from "../util/filesystem"
import { Flag } from "../util/flag"

import { Truncate } from "./truncation"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000

export const log = Log.create({ service: "bash-tool" })

// ── Simple bash command parser ─────────────────────────────────────────────
// Extracts individual commands from a bash string by splitting on ;, &&, ||, |
// For each command, returns { text, words } where words[0] is the command name.

interface ParsedCommand {
  /** Full command text (trimmed) */
  text: string
  /** Tokenized words (respecting quotes) */
  words: string[]
}

function parseBashCommands(input: string): ParsedCommand[] {
  const results: ParsedCommand[] = []

  // Split on command separators: &&, ||, ;, |, newlines
  // This is intentionally simple — AI-generated commands are well-formed
  const segments = input.split(/\s*(?:&&|\|\||[;|\n])\s*/)

  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue

    const words = tokenize(trimmed)
    if (words.length > 0) {
      results.push({ text: trimmed, words })
    }
  }
  return results
}

/** Tokenize a single command string, respecting single/double quotes */
function tokenize(input: string): string[] {
  const words: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  let escape = false

  for (const ch of input) {
    if (escape) {
      current += ch
      escape = false
      continue
    }
    if (ch === "\\" && !inSingle) {
      escape = true
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (current) words.push(current)
  return words
}

// ── Bash Tool ──────────────────────────────────────────────────────────────

export const BashTool = Tool.define("bash", async (initCtx?: Tool.InitContext) => {

  return {
    description: DESCRIPTION.replaceAll("${directory}", initCtx?.directory || "")
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${initCtx?.directory || ""}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const cwd = params.workdir || ctx.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT

      const commands = parseBashCommands(params.command)

      const directories = new Set<string>()
      if (!ctx.containsPath(cwd)) directories.add(cwd)
      const patterns = new Set<string>()
      const always = new Set<string>()

      for (const cmd of commands) {
        if (!cmd.words.length) continue
        const [name, ...args] = cmd.words

        // not an exhaustive list, but covers most common cases
        if (["cd", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"].includes(name)) {
          for (const arg of args) {
            if (arg.startsWith("-") || (name === "chmod" && arg.startsWith("+"))) continue
            const resolved = Filesystem.resolve(path.resolve(cwd, arg))
            log.info("resolved path", { arg, resolved })
            if (resolved) {
              if (!ctx.containsPath(resolved)) {
                const dir = (await Filesystem.isDir(ctx, resolved)) ? resolved : path.dirname(resolved)
                directories.add(dir)
              }
            }
          }
        }

        // cd covered by above check
        if (name !== "cd") {
          patterns.add(cmd.text)
          always.add(name + " *")
        }
      }

      if (directories.size > 0) {
        const globs = Array.from(directories).map((dir) => {
          if (dir.startsWith("/")) return `${dir.replace(/[\\/]+$/, "")}/*`
          return path.join(dir, "*")
        })
        await ctx.ask({
          permission: "external_directory",
          patterns: globs,
          always: globs,
          metadata: {},
        })
      }

      if (patterns.size > 0) {
        await ctx.ask({
          permission: "bash",
          patterns: Array.from(patterns),
          always: Array.from(always),
          metadata: {},
        })
      }

      const proc = ctx.shell.spawn(params.command, {
        cwd,
        env: {},
      })

      let output = ""

      // Initialize metadata with empty output
      ctx.metadata({
        metadata: {
          output: "",
          description: params.description,
        },
      })

      const append = (chunk: Buffer) => {
        output += chunk.toString()
        ctx.metadata({
          metadata: {
            output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
            description: params.description,
          },
        })
      }

      proc.stdout?.on("data", append)
      proc.stderr?.on("data", append)

      let timedOut = false
      let aborted = false
      let exited = false

      const kill = () => ctx.shell.kill(proc, { exited: () => exited })

      if (ctx.abort.aborted) {
        aborted = true
        await kill()
      }

      const abortHandler = () => {
        aborted = true
        void kill()
      }

      ctx.abort.addEventListener("abort", abortHandler, { once: true })

      const timeoutTimer = setTimeout(() => {
        timedOut = true
        void kill()
      }, timeout + 100)

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeoutTimer)
          ctx.abort.removeEventListener("abort", abortHandler)
        }

        proc.once("exit", () => {
          exited = true
          cleanup()
          resolve()
        })

        proc.once("error", (error) => {
          exited = true
          cleanup()
          reject(error)
        })
      })

      const resultMetadata: string[] = []

      if (timedOut) {
        resultMetadata.push(`bash tool terminated command after exceeding timeout ${timeout} ms`)
      }

      if (aborted) {
        resultMetadata.push("User aborted the command")
      }

      if (resultMetadata.length > 0) {
        output += "\n\n<bash_metadata>\n" + resultMetadata.join("\n") + "\n</bash_metadata>"
      }

      return {
        title: params.description,
        metadata: {
          output: output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output,
          exit: proc.exitCode,
          description: params.description,
        },
        output,
      }
    },
  }
})
