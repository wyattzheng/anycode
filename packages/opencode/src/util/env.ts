import type { AgentContext } from "../agent/context"
import { createScopedState } from "../agent/context"

export namespace Env {
  const state = createScopedState(() => {
    return { ...process.env } as Record<string, string | undefined>
  })

  export function get(context: AgentContext, key: string) {
    return state(context)[key]
  }

  export function all(context: AgentContext) {
    return state(context)
  }

  export function set(context: AgentContext, key: string, value: string) {
    state(context)[key] = value
  }

  export function remove(context: AgentContext, key: string) {
    delete state(context)[key]
  }
}
