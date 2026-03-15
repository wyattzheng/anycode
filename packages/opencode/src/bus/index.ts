import type { AgentContext } from "../context"
import { EventEmitter } from "events"
import z from "zod"
import type { ZodType } from "zod"
import { Log } from "../util/log"



// ── BusEvent ────────────────────────────────────────────────────────

export namespace BusEvent {
  const log = Log.create({ service: "event" })

  export type Definition = ReturnType<typeof define>

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties) {
    const result = {
      type,
      properties,
    }
    registry.set(type, result)
    return result
  }

  export function payloads() {
    return z
      .discriminatedUnion(
        "type",
        registry
          .entries()
          .map(([type, def]) => {
            return z
              .object({
                type: z.literal(type),
                properties: def.properties,
              })
              .meta({
                ref: "Event" + "." + def.type,
              })
          })
          .toArray() as any,
      )
      .meta({
        ref: "Event",
      })
  }
}

// ── BusService (per-instance event bus) ─────────────────────────────

/**
 * BusService — per-instance event bus built on EventEmitter.
 *
 * Each CodeAgent instance gets its own BusService.
 */
export class BusService extends EventEmitter {
  private log = Log.create({ service: "bus" })

  async publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    this.log.info("publishing", { type: def.type })
    const pending: any[] = []
    // Emit typed event to local listeners
    const listeners = this.listeners(def.type) as ((event: any) => void)[]
    for (const listener of listeners) {
      pending.push(listener(payload))
    }
    // Emit wildcard event
    const wildcardListeners = this.listeners("*") as ((event: any) => void)[]
    for (const listener of wildcardListeners) {
      pending.push(listener(payload))
    }
    return Promise.all(pending)
  }

  subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    this.log.info("subscribing", { type: def.type })
    this.on(def.type, callback)
    return () => {
      this.log.info("unsubscribing", { type: def.type })
      this.off(def.type, callback)
    }
  }

  once_<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    const unsub = this.subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  subscribeAll(callback: (event: any) => void) {
    this.log.info("subscribing", { type: "*" })
    this.on("*", callback)
    return () => {
      this.log.info("unsubscribing", { type: "*" })
      this.off("*", callback)
    }
  }
}

// ── Backward-compatible namespace wrapper ──────────────────────────

export const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  z.object({
    directory: z.string(),
  }),
)


function getBus(context: AgentContext): BusService {
  return context.bus
}

export namespace Bus {
  export const InstanceDisposed = BusEvent.define(
    "server.instance.disposed",
    z.object({
      directory: z.string(),
    }),
  )

  export async function publish<Definition extends BusEvent.Definition>(
    context: AgentContext,
    def: Definition,
    properties: z.output<Definition["properties"]>,
  ) {
    return getBus(context).publish(def, properties)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    context: AgentContext,
    def: Definition,
    callback: (event: { type: Definition["type"]; properties: z.infer<Definition["properties"]> }) => void,
  ) {
    return getBus(context).subscribe(def, callback)
  }

  export function once<Definition extends BusEvent.Definition>(
    context: AgentContext,
    def: Definition,
    callback: (event: {
      type: Definition["type"]
      properties: z.infer<Definition["properties"]>
    }) => "done" | undefined,
  ) {
    getBus(context).once_(def, callback)
  }

  export function subscribeAll(context: AgentContext, callback: (event: any) => void) {
    return getBus(context).subscribeAll(callback)
  }
}
