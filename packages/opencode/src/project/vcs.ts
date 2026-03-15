import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { FileWatcher } from "@/file/watcher"


const log = Log.create({ service: "vcs" })

export namespace Vcs {
  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  async function currentBranch(context: AgentContext) {
    const result = await context.git.run(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: context.worktree,
    })
    if (result.exitCode !== 0) return
    const text = result.text().trim()
    if (!text) return
    return text
  }

  /**
   * VcsService — tracks current VCS branch and watches for changes.
   */
  export class VcsService {
    branch: string | undefined = undefined
    unsub: (() => void) | undefined = undefined
  }

  const STATE_KEY = Symbol("vcs")
  function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => {
      const result = {
        current: undefined as string | undefined,
        unsub: undefined as (() => void) | undefined,
      }

      // async init - fire and forget
      ;(async () => {
        if (context.project.vcs !== "git") return
        result.current = await currentBranch(context)
        log.info("initialized", { branch: result.current })

        result.unsub = Bus.subscribe(context, FileWatcher.Event.Updated, async (evt) => {
          if (evt.properties.file.endsWith("HEAD")) return
          const next = await currentBranch(context)
          if (next !== result.current) {
            log.info("branch changed", { from: result.current, to: next })
            result.current = next
            Bus.publish(context, Event.BranchUpdated, { branch: next })
          }
        })
      })()

      return result
    })
  }

  export async function init(context: AgentContext) {
    return state(context)
  }

  export async function branch(context: AgentContext) {
    return state(context).current
  }
}
