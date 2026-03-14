import { createScopedState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import path from "path"
import z from "zod"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import { FileWatcher } from "@/file/watcher"
import { git } from "@/util/git"

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
    const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: context.worktree,
    })
    if (result.exitCode !== 0) return
    const text = result.text().trim()
    if (!text) return
    return text
  }

  const state = createScopedState(
    async (context: AgentContext) => {
      if (context.project.vcs !== "git") {
        return { branch: async () => undefined, unsubscribe: undefined }
      }
      let current = await currentBranch(context)
      log.info("initialized", { branch: current })

      const unsubscribe = Bus.subscribe(context, FileWatcher.Event.Updated, async (evt) => {
        if (evt.properties.file.endsWith("HEAD")) return
        const next = await currentBranch(context)
        if (next !== current) {
          log.info("branch changed", { from: current, to: next })
          current = next
          Bus.publish(context, Event.BranchUpdated, { branch: next })
        }
      })

      return {
        branch: async () => current,
        unsubscribe,
      }
    },
    async (state) => {
      state.unsubscribe?.()
    },
  )

  export async function init() {
    return state(undefined as any)
  }

  export async function branch(context: AgentContext) {
    return await state(context).then((s) => s.branch())
  }
}
