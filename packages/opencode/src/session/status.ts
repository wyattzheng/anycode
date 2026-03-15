import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { getState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
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

  const STATE_KEY = Symbol("session.status")
  function state(context: AgentContext) {
    return getState(context, STATE_KEY, () => ({} as Record<string, Info>))
  }

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
    Bus.publish(context, Event.Status, {
      sessionID,
      status,
    })
    if (status.type === "idle") {
      // deprecated
      Bus.publish(context, Event.Idle, {
        sessionID,
      })
      delete state(context)[sessionID]
      return
    }
    state(context)[sessionID] = status
  }
}
