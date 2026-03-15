import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import z from "zod"
import path from "path"
import os from "os"
import { Config } from "../config/config"
import { NamedError } from "@/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/util/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { Discovery } from "./discovery"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"
import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // External skill directories to search for (project-level and global)
  // These follow the directory layout used by Claude Code and other agents.
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  /**
   * SkillService — caches discovered skills from filesystem and URLs.
   */
  export class SkillService {
    readonly _promise: ReturnType<typeof initSkills>

    constructor(context: AgentContext) {
      this._promise = initSkills(context)
    }
  }

  const STATE_KEY = Symbol("skill")
  export function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => new SkillService(context))._promise
  }
  async function initSkills(context: AgentContext) {
    const skills: Record<string, Info> = {}
    const dirs = new Set<string>()

    const addSkill = async (match: string) => {
      const md = await ConfigMarkdown.parse(context, match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(context, Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
      if (!parsed.success) return

      // Warn on duplicate skill names
      if (skills[parsed.data.name]) {
        log.warn("duplicate skill name", {
          name: parsed.data.name,
          existing: skills[parsed.data.name].location,
          duplicate: match,
        })
      }

      dirs.add(path.dirname(match))

      skills[parsed.data.name] = {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
      }
    }

    const scanExternal = async (root: string, scope: "global" | "project") => {
      return Glob.scan(context, EXTERNAL_SKILL_PATTERN, {
        cwd: root,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
        .then((matches) => Promise.all(matches.map(addSkill)))
        .catch((error) => {
          log.error(`failed to scan ${scope} skills`, { dir: root, error })
        })
    }

    // Scan external skill directories (.claude/skills/, .agents/skills/, etc.)
    // Load global (home) first, then project-level (so project-level overwrites)
    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(context.paths.home, dir)
        if (!(await Filesystem.isDir(context, root))) continue
        await scanExternal(root, "global")
      }

      for await (const root of Filesystem.up(context, {
        targets: EXTERNAL_DIRS,
        start: context.directory,
        stop: context.worktree,
      })) {
        await scanExternal(root, "project")
      }
    }

    // Scan .opencode/skill/ directories
    for (const dir of await Config.directories(context)) {
      const matches = await Glob.scan(context, OPENCODE_SKILL_PATTERN, {
        cwd: dir,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Scan additional skill paths from config
    const config = await Config.get(context)
    for (const skillPath of config.skills?.paths ?? []) {
      const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(context.directory, expanded)
      if (!(await Filesystem.isDir(context, resolved))) {
        log.warn("skill path not found", { path: resolved })
        continue
      }
      const matches = await Glob.scan(context, SKILL_PATTERN, {
        cwd: resolved,
        absolute: true,
        include: "file",
        symlink: true,
      })
      for (const match of matches) {
        await addSkill(match)
      }
    }

    // Download and load skills from URLs
    for (const url of config.skills?.urls ?? []) {
      const list = await Discovery.pull(context, url)
      for (const dir of list) {
        dirs.add(dir)
        const matches = await Glob.scan(context, SKILL_PATTERN, {
          cwd: dir,
          absolute: true,
          include: "file",
          symlink: true,
        })
        for (const match of matches) {
          await addSkill(match)
        }
      }
    }

    return {
      skills,
      dirs: Array.from(dirs),
    }
  }

  export async function get(context: AgentContext, name: string) {
    return state(context).then((x) => x.skills[name])
  }

  export async function all(context: AgentContext) {
    return state(context).then((x) => Object.values(x.skills))
  }

  export async function dirs(context: AgentContext) {
    return state(context).then((x) => x.dirs)
  }

  export async function available(context: AgentContext, agent?: Agent.Info) {
    const list = await all(context)
    if (!agent) return list
    return list.filter((skill) => PermissionNext.evaluate("skill", skill.name, agent.permission).action !== "deny")
  }

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) {
      return "No skills are currently available."
    }
    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list.flatMap((skill) => [
          `  <skill>`,
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          `  </skill>`,
        ]),
        "</available_skills>",
      ].join("\n")
    }
    return ["## Available Skills", ...list.flatMap((skill) => `- **${skill.name}**: ${skill.description}`)].join("\n")
  }
}
