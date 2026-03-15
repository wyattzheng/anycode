import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID, MessageID } from "@/session/schema"
import z from "zod"
import { Log } from "../util/log"
import { Plugin } from "../util/plugin"
import { Wildcard } from "../util/wildcard"
import { PermissionID } from "./schema"

export namespace Permission {
  const log = Log.create({ service: "permission" })

  function toKeys(pattern: Info["pattern"], type: string): string[] {
    return pattern === undefined ? [type] : Array.isArray(pattern) ? pattern : [pattern]
  }

  function covered(keys: string[], approved: Map<string, boolean>): boolean {
    return keys.every((k) => {
      for (const p of approved.keys()) {
        if (Wildcard.match(k, p)) return true
      }
      return false
    })
  }

  export const Info = z
    .object({
      id: PermissionID.zod,
      type: z.string(),
      pattern: z.union([z.string(), z.array(z.string())]).optional(),
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      callID: z.string().optional(),
      message: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        created: z.number(),
      }),
    })
    .meta({
      ref: "Permission",
    })
  export type Info = z.infer<typeof Info>

  interface PendingEntry {
    info: Info
    resolve: () => void
    reject: (e: any) => void
  }

  export const Event = {
    Updated: BusEvent.define("permission.updated", Info),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: SessionID.zod,
        permissionID: PermissionID.zod,
        response: z.string(),
      }),
    ),
  }

  /**
   * PermissionService — manages pending permission requests and approved patterns.
   */
  export class PermissionService {
    readonly pending = new Map<SessionID, Map<PermissionID, PendingEntry>>()
    readonly approved = new Map<SessionID, Map<string, boolean>>()
  }

  const STATE_KEY = Symbol("permission")
  function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => new PermissionService())
  }

  export function pending(context: AgentContext) {
    return state(context).pending
  }

  export function list(context: AgentContext) {
    const { pending } = state(context)
    const result: Info[] = []
    for (const session of pending.values()) {
      for (const item of session.values()) {
        result.push(item.info)
      }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id))
  }

  export async function ask(context: AgentContext, input: {
    type: Info["type"]
    message: Info["message"]
    pattern?: Info["pattern"]
    callID?: Info["callID"]
    sessionID: Info["sessionID"]
    messageID: Info["messageID"]
    metadata: Info["metadata"]
  }) {
    const { pending, approved } = state(context)
    log.info("asking", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      toolCallID: input.callID,
      pattern: input.pattern,
    })
    const approvedForSession = approved.get(input.sessionID)
    const keys = toKeys(input.pattern, input.type)
    if (approvedForSession && covered(keys, approvedForSession)) return
    const info: Info = {
      id: PermissionID.ascending(),
      type: input.type,
      pattern: input.pattern,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      message: input.message,
      metadata: input.metadata,
      time: {
        created: Date.now(),
      },
    }

    switch (
      await Plugin.trigger("permission.ask", info, {
        status: "ask",
      }).then((x) => x.status)
    ) {
      case "deny":
        throw new RejectedError(info.sessionID, info.id, info.callID, info.metadata)
      case "allow":
        return
    }

    if (!pending.has(input.sessionID)) pending.set(input.sessionID, new Map())
    return new Promise<void>((resolve, reject) => {
      pending.get(input.sessionID)!.set(info.id, {
        info,
        resolve,
        reject,
      })
      Bus.publish(context, Event.Updated, info)
    })
  }

  export const Response = z.enum(["once", "always", "reject"])
  export type Response = z.infer<typeof Response>

  export function respond(context: AgentContext, input: { sessionID: Info["sessionID"]; permissionID: Info["id"]; response: Response }) {
    log.info("response", input)
    const { pending, approved } = state(context)
    const session = pending.get(input.sessionID)
    const match = session?.get(input.permissionID)
    if (!session || !match) return
    session.delete(input.permissionID)
    if (session.size === 0) pending.delete(input.sessionID)
    Bus.publish(context, Event.Replied, {
      sessionID: input.sessionID,
      permissionID: input.permissionID,
      response: input.response,
    })
    if (input.response === "reject") {
      match.reject(new RejectedError(input.sessionID, input.permissionID, match.info.callID, match.info.metadata))
      return
    }
    match.resolve()
    if (input.response === "always") {
      if (!approved.has(input.sessionID)) approved.set(input.sessionID, new Map())
      const approvedSession = approved.get(input.sessionID)!
      const approveKeys = toKeys(match.info.pattern, match.info.type)
      for (const k of approveKeys) {
        approvedSession.set(k, true)
      }
      const items = pending.get(input.sessionID)
      if (!items) return
      const toRespond: Info[] = []
      for (const item of items.values()) {
        const itemKeys = toKeys(item.info.pattern, item.info.type)
        if (covered(itemKeys, approvedSession)) {
          toRespond.push(item.info)
        }
      }
      for (const item of toRespond) {
        respond(context, {
          sessionID: item.sessionID,
          permissionID: item.id,
          response: input.response,
        })
      }
    }
  }

  export class RejectedError extends Error {
    constructor(
      public readonly sessionID: SessionID,
      public readonly permissionID: PermissionID,
      public readonly toolCallID?: string,
      public readonly metadata?: Record<string, any>,
      public readonly reason?: string,
    ) {
      super(
        reason !== undefined
          ? reason
          : `The user rejected permission to use this specific tool call. You may try again with different parameters.`,
      )
    }
  }
}
