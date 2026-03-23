import type { AgentContext } from "../context"
import * as path from "../util/path"
import z from "zod"
import { ConfigMarkdown } from "../util/markdown"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"

// ── Skill ───────────────────────────────────────────────────────────────────

export namespace Skill {
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  /** Directories to scan for skills (project-level) */
  const SKILL_DIRS = [".claude", ".agents", ".opencode"]
  const SKILL_GLOB = "skills/**/SKILL.md"
  const ANY_SKILL_GLOB = "**/SKILL.md"

  /**
   * SkillService — discovers and caches skills from filesystem.
   */
  export class SkillService {
    private readonly _promise: ReturnType<typeof discover>

    constructor(context: AgentContext) {
      this._promise = discover(context)
    }

    async get(name: string): Promise<Info | undefined> {
      return (await this._promise).skills[name]
    }

    async all(): Promise<Info[]> {
      return Object.values((await this._promise).skills)
    }

    async dirs(): Promise<string[]> {
      return (await this._promise).dirs
    }
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  async function discover(context: AgentContext) {
    const log = context.log.create({ service: "skill" })
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(context, match).catch((err: Error | null): any => {
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })
      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      if (skills[parsed.data.name]) {
        log.warn("duplicate skill", { name: parsed.data.name, existing: skills[parsed.data.name].location, duplicate: match })
      }

      dirs.add(path.dirname(match))
      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    const scan = async (pattern: string, cwd: string) => {
      const matches = await Glob.scan(context, pattern, { cwd, absolute: true, include: "file", dot: true, symlink: true }).catch(() => [] as string[])
      await Promise.all(matches.map(addSkill))
    }

    // 1. Scan project-level skill directories (.claude/skills/, .agents/skills/, etc.)
    for await (const root of Filesystem.up(context, {
      targets: SKILL_DIRS,
      start: context.directory,
      stop: context.worktree,
    })) {
      await scan(SKILL_GLOB, root)
    }

    // 2. Scan additional skill paths from config
    for (const skillPath of context.config.skills?.paths ?? []) {
      const resolved = path.isAbsolute(skillPath) ? skillPath : path.join(context.directory, skillPath)
      if (!(await Filesystem.isDir(context, resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      await scan(ANY_SKILL_GLOB, resolved)
    }

    return { skills, dirs: Array.from(dirs) }
  }

  // ── Formatting ────────────────────────────────────────────────────────

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) return "No skills are currently available."
    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((s) => [
          `  <skill>`,
          `    <name>${s.name}</name>`,
          `    <description>${s.description}</description>`,
          `    <location>${pathToFileURL(s.location).href}</location>`,
          `  </skill>`,
        ]),
        "</available_skills>",
      ].join("\n")
    }
    return ["## Available Skills", ...list.map((s) => `- **${s.name}**: ${s.description}`)].join("\n")
  }
}
