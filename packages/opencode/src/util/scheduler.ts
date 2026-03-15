import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { Log } from "../util/log"

export namespace Scheduler {
  const log = Log.create({ service: "scheduler" })

  export type Task = {
    id: string
    interval: number
    run: () => Promise<void>
    scope?: "instance" | "global"
  }

  type Timer = ReturnType<typeof setInterval>
  type Entry = {
    tasks: Map<string, Task>
    timers: Map<string, Timer>
  }

  const create = (): Entry => {
    const tasks = new Map<string, Task>()
    const timers = new Map<string, Timer>()
    return { tasks, timers }
  }

  const shared = create()

  const STATE_KEY = Symbol("scheduler")
  function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => create())
  }

  export function register(context: AgentContext, task: Task) {
    const scope = task.scope ?? "instance"
    const entry = scope === "global" ? shared : state(context)
    const current = entry.timers.get(task.id)
    if (current && scope === "global") return
    if (current) clearInterval(current)

    entry.tasks.set(task.id, task)
    void run(task)
    const timer = setInterval(() => {
      void run(task)
    }, task.interval)
    timer.unref()
    entry.timers.set(task.id, timer)
  }

  async function run(task: Task) {
    log.info("run", { id: task.id })
    await task.run().catch((error) => {
      log.error("run failed", { id: task.id, error })
    })
  }
}
