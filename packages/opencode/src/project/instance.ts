import { Context } from "../util/context"
import { AgentContext } from "../agent/context"
import { State } from "./state"
import { GlobalBus } from "../bus/global"
import { iife } from "../util/iife"

export interface InstancePaths {
  data: string
  bin: string
  log: string
  cache: string
  config: string
  state: string
  home: string
}



const context = Context.create<AgentContext>("instance")

export const Instance = {
  provide<R>(ctx: AgentContext, fn: () => R | Promise<R>): Promise<R> {
    return context.provide(ctx, async () => {
      return fn()
    })
  },
  get directory() { return context.use().directory },
  get worktree() { return context.use().worktree },
  get project() { return context.use().project },
  get scopeId() { return context.use().scopeId },
  get vfs(): import("../util/vfs").VFS { return context.use().fs },
  get config() { return context.use().config },
  get search() { return context.use().search },
  get paths() { return context.use().paths },
  get instructions() { return context.use().instructions },
  
  containsPath(filepath: string) { return context.use().containsPath(filepath) },
  
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => `${Instance.directory}::${Instance.scopeId}`, init, dispose)
  },

  async reload() { /* noop for stateless context */ },
  async dispose() {
    try {
        const ctx = context.use()
        if (ctx) {
            GlobalBus.emit("event", {
                directory: ctx.directory,
                payload: {
                    type: "server.instance.disposed",
                    properties: { directory: ctx.directory },
                },
            })
        }
    } catch {}
  },
  async disposeAll() { /* noop */ }
}

