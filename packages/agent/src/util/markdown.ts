import type { AgentContext } from "../context"
import { NamedError } from "./error"
import { z } from "zod"


/** Simple frontmatter parser — replaces gray-matter (CJS, depends on fs) */
function parseFrontmatter(input: string): { data: Record<string, string>; content: string } {
  const match = input.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { data: {}, content: input }

  const yaml = match[1]
  const data: Record<string, string> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_]\w*)\s*:\s*(.*)$/)
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "")
  }

  const content = input.slice(match[0].length).replace(/^\r?\n/, "")
  return { data, content }
}


export namespace ConfigMarkdown {
  export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
  export const SHELL_REGEX = /!`([^`]+)`/g

  export function files(template: string) {
    return Array.from(template.matchAll(FILE_REGEX))
  }

  export function shell(template: string) {
    return Array.from(template.matchAll(SHELL_REGEX))
  }

  // other coding agents like claude code allow invalid yaml in their
  // frontmatter, we need to fallback to a more permissive parser for those cases
  export function fallbackSanitization(content: string): string {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return content

    const frontmatter = match[1]
    const lines = frontmatter.split(/\r?\n/)
    const result: string[] = []

    for (const line of lines) {
      // skip comments and empty lines
      if (line.trim().startsWith("#") || line.trim() === "") {
        result.push(line)
        continue
      }

      // skip lines that are continuations (indented)
      if (line.match(/^\s+/)) {
        result.push(line)
        continue
      }

      // match key: value pattern
      const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
      if (!kvMatch) {
        result.push(line)
        continue
      }

      const key = kvMatch[1]
      const value = kvMatch[2].trim()

      // skip if value is empty, already quoted, or uses block scalar
      if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
        result.push(line)
        continue
      }

      // if value contains a colon, convert to block scalar
      if (value.includes(":")) {
        result.push(`${key}: |-`)
        result.push(`  ${value}`)
        continue
      }

      result.push(line)
    }

    const processed = result.join("\n")
    return content.replace(frontmatter, () => processed)
  }

  export async function parse(context: AgentContext, filePath: string) {
    const template = await context.fs.readText(filePath)

    try {
      return parseFrontmatter(template)
    } catch {
      try {
        return parseFrontmatter(fallbackSanitization(template))
      } catch (err) {
        throw new FrontmatterError(
          {
            path: filePath,
            message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
          },
          { cause: err },
        )
      }
    }
  }

  export const FrontmatterError = NamedError.create(
    "ConfigFrontmatterError",
    z.object({
      path: z.string(),
      message: z.string(),
    }),
  )
}
