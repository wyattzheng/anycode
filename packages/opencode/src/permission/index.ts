// ── Schema ──────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import z from "zod"
import { Identifier } from "@/util/id"
import { withStatics } from "@/util/schema"

const permissionIdSchema = Schema.String.pipe(Schema.brand("PermissionID"))

export type PermissionID = typeof permissionIdSchema.Type

export const PermissionID = permissionIdSchema.pipe(
  withStatics((schema: typeof permissionIdSchema) => ({
    make: (id: string) => schema.makeUnsafe(id),
    ascending: (id?: string) => schema.makeUnsafe(Identifier.ascending("permission", id)),
    zod: Identifier.schema("permission").pipe(z.custom<PermissionID>()),
  })),
)

// ── BashArity ───────────────────────────────────────────────────────────────

export namespace BashArity {
  export function prefix(tokens: string[]) {
    for (let len = tokens.length; len > 0; len--) {
      const prefix = tokens.slice(0, len).join(" ")
      const arity = ARITY[prefix]
      if (arity !== undefined) return tokens.slice(0, arity)
    }
    if (tokens.length === 0) return []
    return tokens.slice(0, 1)
  }

  const ARITY: Record<string, number> = {
    cat: 1, cd: 1, chmod: 1, chown: 1, cp: 1, echo: 1, env: 1, export: 1,
    grep: 1, kill: 1, killall: 1, ln: 1, ls: 1, mkdir: 1, mv: 1, ps: 1,
    pwd: 1, rm: 1, rmdir: 1, sleep: 1, source: 1, tail: 1, touch: 1,
    unset: 1, which: 1,
    aws: 3, az: 3,
    bazel: 2, brew: 2, bun: 2, "bun run": 3, "bun x": 3,
    cargo: 2, "cargo add": 3, "cargo run": 3,
    cmake: 2, composer: 2, deno: 2, "deno task": 3,
    docker: 2, "docker compose": 3, "docker container": 3,
    git: 2, "git config": 3, "git remote": 3, "git stash": 3,
    go: 2, gradle: 2, helm: 2,
    kubectl: 2, make: 2,
    npm: 2, "npm exec": 3, "npm run": 3,
    nvm: 2, pip: 2, pnpm: 2, "pnpm run": 3,
    poetry: 2, python: 2, rake: 2,
    rustup: 2, swift: 2, terraform: 2,
    turbo: 2, vercel: 2, yarn: 2, "yarn run": 3,
  }
}

// ── PermissionNext (stubbed — always allow) ─────────────────────────────────

import type { AgentContext } from "@/agent/context"
import { SessionID, MessageID } from "@/session/schema"

export namespace PermissionNext {
  export const Action = z.enum(["allow", "deny", "ask"])
  export type Action = z.infer<typeof Action>

  export const Rule = z.object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
  })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array()
  export type Ruleset = z.infer<typeof Ruleset>

  export function fromConfig(_permission: Record<string, unknown>): Ruleset {
    return []
  }

  export function merge(..._rulesets: Ruleset[]): Ruleset {
    return []
  }

  export const Request = z.object({
    id: PermissionID.zod,
    sessionID: SessionID.zod,
    permission: z.string(),
    patterns: z.string().array(),
    metadata: z.record(z.string(), z.any()),
    always: z.string().array(),
    tool: z.object({
      messageID: MessageID.zod,
      callID: z.string(),
    }).optional(),
  })
  export type Request = z.infer<typeof Request>

  /** Always-allow service — no permission checks. */
  export class PermissionNextService {
    readonly pending = new Map<PermissionID, any>()
    approved: Ruleset = []

    constructor(_context: AgentContext) {}
    bind(_context: AgentContext) {}

    async ask(_input: any): Promise<void> {
      // Always allowed — no-op
    }

    async reply(_input: any): Promise<void> {}

    list() {
      return []
    }
  }

  /** Always returns "allow" */
  export function evaluate(permission: string, pattern: string, ..._rulesets: Ruleset[]): Rule {
    return { action: "allow", permission, pattern }
  }

  /** No tools are ever disabled */
  export function disabled(_tools: string[], _ruleset: Ruleset): Set<string> {
    return new Set()
  }

  export class RejectedError extends Error {
    constructor() {
      super("Permission rejected")
    }
  }

  export class CorrectedError extends Error {
    constructor(message: string) {
      super(`Permission rejected: ${message}`)
    }
  }

  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super("Permission denied by rule")
    }
  }
}

// ── Permission (legacy — stubbed) ───────────────────────────────────────────

export namespace Permission {
  export const Info = z.object({
    id: PermissionID.zod,
    type: z.string(),
    pattern: z.union([z.string(), z.array(z.string())]).optional(),
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    callID: z.string().optional(),
    message: z.string(),
    metadata: z.record(z.string(), z.any()),
    time: z.object({ created: z.number() }),
  })
  export type Info = z.infer<typeof Info>

  export class PermissionService {
    readonly pending = new Map<SessionID, Map<PermissionID, any>>()
    readonly approved = new Map<SessionID, Map<string, boolean>>()
  }

  export class RejectedError extends Error {
    constructor(
      public readonly sessionID: SessionID,
      public readonly permissionID: PermissionID,
      public readonly toolCallID?: string,
      public readonly metadata?: Record<string, any>,
      public readonly reason?: string,
    ) {
      super(reason ?? "Permission rejected")
    }
  }
}
