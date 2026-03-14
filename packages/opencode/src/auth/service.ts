/**
 * Auth service stub — original auth/service was removed during agent-mode cleanup.
 * Used by provider/auth-service.ts which depends on Effect framework.
 */
import { Effect, Context, Layer } from "effect"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"

export const AuthServiceError = NamedError.create("AuthServiceError", z.object({}))
export type AuthServiceError = InstanceType<typeof AuthServiceError>

export class AuthService extends Context.Tag("AuthService")<AuthService, {
  readonly get: (providerID: string) => Effect.Effect<Record<string, unknown> | undefined>
  readonly set: (providerID: string, data: Record<string, unknown>) => Effect.Effect<void>
  readonly remove: (providerID: string) => Effect.Effect<void>
  readonly all: () => Effect.Effect<Record<string, Record<string, unknown>>>
}>() {
  static readonly defaultLayer = Layer.succeed(AuthService, {
    get: () => Effect.succeed(undefined),
    set: () => Effect.void,
    remove: () => Effect.void,
    all: () => Effect.succeed({}),
  })
}
