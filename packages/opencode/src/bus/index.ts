import { createScopedState } from "@/agent/context"
import type { AgentContext } from "@/agent/context"
import z from "zod"
import { Log } from "../util/log"
import { BusEvent } from "./bus-event"
import { GlobalBus } from "./global"

export namespace Bus {
  const log = Log.create({ service: "bus" })
  type Subscription = (event: any) => void

  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  const state = createScopedState(
    (_context: AgentContext) => {
      const subscriptions = new Map<any, Subscription[]>()

      return {
        subscriptions,
      }
    },
    async (entry: { subscriptions: Map<any, Subscription[]> }) => {
      const wildcard = entry.subscriptions.get("*")
      if (!wildcard) return
      const event = {
        type: InstanceDisposed.type,
        properties: {
          directory: "",
        },
      }
      for (const sub of [...wildcard]) {
        sub(event)
      }
    },
  )

  export async function publish<Definition extends BusEvent.Definition>(context: AgentContext | undefined, 
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    log.info("publishing", {
      type: def.type,
    })
    const pending = []
    if (context) {
      for (const key of [def.type, "*"]) {
        const match = state(context).subscriptions.get(key)
        for (const sub of match ?? []) {
          pending.push(sub(payload))
        }
      }
    }
    GlobalBus.emit("event", {
      directory: context?.directory,
      payload,
    })
    return Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    context: AgentContext,
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    const res = raw(context, def.type, callback)
    return res
  }

  export function once<Definition extends BusEvent.Definition>(
    context: AgentContext,
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = subscribe(context, def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(context: AgentContext, callback: (event: any) => void) {
    return raw(context, "*", callback)
  }

  function raw(context: AgentContext, type: string, callback: (event: any) => void) {
    log.info("subscribing", { type })
    const subscriptions = state(context).subscriptions
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      log.info("unsubscribing", { type })
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }
}
