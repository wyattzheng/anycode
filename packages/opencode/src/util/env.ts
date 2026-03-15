import type { AgentContext } from "../agent/context"

/**
 * EnvService — per-instance environment variable snapshot.
 *
 * Each CodeAgent instance gets its own env copy so tests / parallel
 * agents don't leak state into each other via process.env.
 */
export class EnvService {
  private env: Record<string, string | undefined>

  constructor() {
    this.env = { ...process.env } as Record<string, string | undefined>
  }

  get(key: string): string | undefined {
    return this.env[key]
  }

  all(): Record<string, string | undefined> {
    return this.env
  }

  set(key: string, value: string): void {
    this.env[key] = value
  }

  remove(key: string): void {
    delete this.env[key]
  }
}

// ── Backward-compatible namespace wrapper ──────────────────────────
// During the migration, existing call sites still use `Env.get(context, key)`.
// This wrapper delegates to the EnvService instance on context.
// Once all call sites are updated, this namespace can be removed.


const STATE_KEY = Symbol("env")

export namespace Env {
  function state(context: AgentContext) {
    if (context.env) return context.env
    return getState(context, STATE_KEY, () => new EnvService())
  }

  export function get(context: AgentContext, key: string) {
    return context.env.get(key)
  }

  export function all(context: AgentContext) {
    return context.env.all()
  }

  export function set(context: AgentContext, key: string, value: string) {
    context.env.set(key, value)
  }

  export function remove(context: AgentContext, key: string) {
    context.env.remove(key)
  }
}
