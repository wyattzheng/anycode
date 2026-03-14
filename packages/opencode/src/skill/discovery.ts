import type { AgentContext } from "@/agent/context"
import path from "path"

import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { Filesystem } from "../util/filesystem"

export namespace Discovery {
  const log = Log.create({ service: "skill-discovery" })

  type Index = {
    skills: Array<{
      name: string
      description: string
      files: string[]
    }>
  }

  export function dir(context: AgentContext) {
    return path.join(context.paths.cache, "skills")
  }

  async function get(context: AgentContext, url: string, dest: string): Promise<boolean> {
    if (await Filesystem.exists(context, dest)) return true
    return fetch(url)
      .then(async (response) => {
        if (!response.ok) {
          log.error("failed to download", { url, status: response.status })
          return false
        }
        if (response.body) {
          const bytes = new Uint8Array(await response.arrayBuffer())
          await Filesystem.mkdir(context, path.dirname(dest))
          await Filesystem.write(context, dest, bytes)
        }
        return true
      })
      .catch((err) => {
        log.error("failed to download", { url, err })
        return false
      })
  }

  export async function pull(context: AgentContext, url: string): Promise<string[]> {
    const result: string[] = []
    const base = url.endsWith("/") ? url : `${url}/`
    const index = new URL("index.json", base).href
    const cache = dir(context)
    const host = base.slice(0, -1)

    log.info("fetching index", { url: index })
    const data = await fetch(index)
      .then(async (response) => {
        if (!response.ok) {
          log.error("failed to fetch index", { url: index, status: response.status })
          return undefined
        }
        return response
          .json()
          .then((json) => json as Index)
          .catch((err) => {
            log.error("failed to parse index", { url: index, err })
            return undefined
          })
      })
      .catch((err) => {
        log.error("failed to fetch index", { url: index, err })
        return undefined
      })

    if (!data?.skills || !Array.isArray(data.skills)) {
      log.warn("invalid index format", { url: index })
      return result
    }

    const list = data.skills.filter((skill) => {
      if (!skill?.name || !Array.isArray(skill.files)) {
        log.warn("invalid skill entry", { url: index, skill })
        return false
      }
      return true
    })

    await Promise.all(
      list.map(async (skill) => {
        const root = path.join(cache, skill.name)
        await Promise.all(
          skill.files.map(async (file) => {
            const link = new URL(file, `${host}/${skill.name}/`).href
            const dest = path.join(root, file)
            await Filesystem.mkdir(context, path.dirname(dest))
            await get(context, link, dest)
          }),
        )

        const md = path.join(root, "SKILL.md")
        if (await Filesystem.exists(context, md)) result.push(root)
      }),
    )

    return result
  }
}
