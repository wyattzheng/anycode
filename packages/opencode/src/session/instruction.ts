import path from "path"
import os from "os"
import { Filesystem } from "../util/filesystem"
import { Config } from "../config/config"
import type { AgentContext } from "@/agent/context"
import { Flag } from "@/util/flag"
import { Log } from "../util/log"
import { Glob } from "../util/glob"
import type { MessageV2 } from "./message-v2"

const log = Log.create({ service: "instruction" })

const FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md", // deprecated
]

function globalFiles(context: AgentContext) {
  const files = []
  if (Flag.OPENCODE_CONFIG_DIR) {
    files.push(path.join(Flag.OPENCODE_CONFIG_DIR, "AGENTS.md"))
  }
  files.push(path.join(context.paths.config, "AGENTS.md"))
  if (!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT) {
    files.push(path.join(os.homedir(), ".claude", "CLAUDE.md"))
  }
  return files
}

async function resolveRelative(context: AgentContext, instruction: string): Promise<string[]> {
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return Filesystem.globUp(context, instruction, context.directory, context.worktree).catch(() => [])
  }
  if (!Flag.OPENCODE_CONFIG_DIR) {
    log.warn(
      `Skipping relative instruction "${instruction}" - no OPENCODE_CONFIG_DIR set while project config is disabled`,
    )
    return []
  }
  return Filesystem.globUp(context, instruction, Flag.OPENCODE_CONFIG_DIR, Flag.OPENCODE_CONFIG_DIR).catch(() => [])
}

export namespace InstructionPrompt {
  /**
   * InstructionService — tracks claimed instruction files per session.
   * All logic is now in instance methods.
   */
  export class InstructionService {
    readonly claims = new Map<string, Set<string>>()
    private context!: AgentContext

    bind(context: AgentContext) {
      this.context = context
    }

    clear(messageID: string) {
      this.claims.delete(messageID)
    }

    private isClaimed(messageID: string, filepath: string) {
      const claimed = this.claims.get(messageID)
      if (!claimed) return false
      return claimed.has(filepath)
    }

    private claim(messageID: string, filepath: string) {
      let claimed = this.claims.get(messageID)
      if (!claimed) {
        claimed = new Set()
        this.claims.set(messageID, claimed)
      }
      claimed.add(filepath)
    }

    async systemPaths() {
      const config = await this.context.config.get()
      const paths = new Set<string>()

      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        for (const file of FILES) {
          const matches = await Filesystem.findUp(this.context, file, this.context.directory, this.context.worktree)
          if (matches.length > 0) {
            matches.forEach((p) => {
              paths.add(path.resolve(p))
            })
            break
          }
        }
      }

      for (const file of globalFiles(this.context)) {
        if (await Filesystem.exists(this.context, file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      if (config.instructions) {
        for (let instruction of config.instructions) {
          if (instruction.startsWith("https://") || instruction.startsWith("http://")) continue
          if (instruction.startsWith("~/")) {
            instruction = path.join(os.homedir(), instruction.slice(2))
          }
          const matches = path.isAbsolute(instruction)
            ? await Glob.scan(this.context, path.basename(instruction), {
                cwd: path.dirname(instruction),
                absolute: true,
                include: "file",
              }).catch(() => [])
            : await resolveRelative(this.context, instruction)
          matches.forEach((p) => {
            paths.add(path.resolve(p))
          })
        }
      }

      return paths
    }

    async system() {
      // Short-circuit: if instructions were injected via AgentContext,
      // skip all filesystem-based instruction loading.
      const injected = this.context.instructions
      if (injected) {
        return injected
      }

      const config = await this.context.config.get()
      const paths = await this.systemPaths()

      const files = Array.from(paths).map(async (p) => {
        const content = await Filesystem.readText(this.context, p).catch(() => "")
        return content ? "Instructions from: " + p + "\n" + content : ""
      })

      const urls: string[] = []
      if (config.instructions) {
        for (const instruction of config.instructions) {
          if (instruction.startsWith("https://") || instruction.startsWith("http://")) {
            urls.push(instruction)
          }
        }
      }
      const fetches = urls.map((url) =>
        fetch(url, { signal: AbortSignal.timeout(5000) })
          .then((res) => (res.ok ? res.text() : ""))
          .catch(() => "")
          .then((x) => (x ? "Instructions from: " + url + "\n" + x : "")),
      )

      return Promise.all([...files, ...fetches]).then((result) => result.filter(Boolean))
    }

    async find(dir: string) {
      for (const file of FILES) {
        const filepath = path.resolve(path.join(dir, file))
        if (await Filesystem.exists(this.context, filepath)) return filepath
      }
    }

    async resolve(messages: MessageV2.WithParts[], filepath: string, messageID: string) {
      const system = await this.systemPaths()
      const already = loaded(messages)
      const results: { filepath: string; content: string }[] = []

      const target = path.resolve(filepath)
      let current = path.dirname(target)
      const root = path.resolve(this.context.directory)

      while (current.startsWith(root) && current !== root) {
        const found = await this.find(current)

        if (found && found !== target && !system.has(found) && !already.has(found) && !this.isClaimed(messageID, found)) {
          this.claim(messageID, found)
          const content = await Filesystem.readText(this.context, found).catch(() => undefined)
          if (content) {
            results.push({ filepath: found, content: "Instructions from: " + found + "\n" + content })
          }
        }
        current = path.dirname(current)
      }

      return results
    }
  }

  /** Pure function — scans messages for loaded instruction paths */
  export function loaded(messages: MessageV2.WithParts[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }
}
