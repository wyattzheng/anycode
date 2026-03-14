import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { createScopedState, AgentContext } from "@/agent/context"
import { SessionID } from "./schema"
import z from "zod"

export namespace SessionStatus {
  export const Info = z
    .union([
      z.object({
        type: z.literal("idle"),
      }),
      z.object({
        type: z.literal("retry"),
        attempt: z.number(),
        message: z.string(),
        next: z.number(),
      }),
      z.object({
        type: z.literal("busy"),
      }),
    ])
    .meta({
      ref: "SessionStatus",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Status: BusEvent.define(
      "session.status",
      z.object({
        sessionID: SessionID.zod,
        status: Info,
      }),
    ),
    // deprecated
    Idle: BusEvent.define(
      "session.idle",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const state = createScopedState(() => {
    const data: Record<string, Info> = {}
    return data
  })

  export function get(context: AgentContext, sessionID: SessionID) {
    return (
      state(context)[sessionID] ?? {
        type: "idle",
      }
    )
  }

  export function list(context: AgentContext) {
    return state(context)
  }

  export function set(context: AgentContext, sessionID: SessionID, status: Info) {
    Bus.publish(Event.Status, {
      sessionID,
      status,
    })
    if (status.type === "idle") {
      // deprecated
      Bus.publish(Event.Idle, {
        sessionID,
      })
      delete state(context)[sessionID]
      return
    }
    state(context)[sessionID] = status
  }
}
