import type { AgentContext } from "@/agent/context"
import { getState } from "@/agent/context"
import { Log } from "../util/log"

/**
 * SchedulerService — per-instance task scheduler with interval timers.
 */
export class SchedulerService {
  private log = Log.create({ service: "scheduler" })
  private tasks = new Map<string, SchedulerService.Task>()
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  register(task: SchedulerService.Task) {
    const current = this.timers.get(task.id)
    if (current) clearInterval(current)

    this.tasks.set(task.id, task)
    void this.run(task)
    const timer = setInterval(() => {
      void this.run(task)
    }, task.interval)
    timer.unref()
    this.timers.set(task.id, timer)
  }

  private async run(task: SchedulerService.Task) {
    this.log.info("run", { id: task.id })
    await task.run().catch((error) => {
      this.log.error("run failed", { id: task.id, error })
    })
  }

  dispose() {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.tasks.clear()
    this.timers.clear()
  }
}

export namespace SchedulerService {
  export type Task = {
    id: string
    interval: number
    run: () => Promise<void>
  }
}

// ── Backward-compatible namespace wrapper ──────────────────────────
// Handles both "instance" and "global" scoped tasks.

const STATE_KEY = Symbol("scheduler")
const shared = new SchedulerService()

export namespace Scheduler {
  export type Task = {
    id: string
    interval: number
    run: () => Promise<void>
    scope?: "instance" | "global"
  }

  function state(context: AgentContext) {
    if (context.scheduler) return context.scheduler
    return getState(context, STATE_KEY, () => new SchedulerService())
  }

  export function register(context: AgentContext, task: Task) {
    const scope = task.scope ?? "instance"
    const svc = scope === "global" ? shared : state(context)

    // For global tasks, skip if already registered
    if (scope === "global" && svc === shared) {
      const existing = (shared as any).timers?.get(task.id)
      if (existing) return
    }

    svc.register(task)
  }
}
