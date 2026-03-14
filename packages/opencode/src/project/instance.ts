import { Effect } from "effect"
import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { Filesystem } from "@/util/filesystem"
import { InstanceState } from "@/util/instance-state"
import type { VFS } from "@/util/vfs"

export interface InstancePaths {
  data: string
  bin: string
  log: string
  cache: string
  config: string
  state: string
  home: string
}

interface Context {
  directory: string
  worktree: string
  project: Project.Info
  scopeId: string
  vfs?: VFS
  search?: import("../util/search").SearchProvider
  paths?: InstancePaths
  config?: Record<string, unknown>
  instructions?: string[]
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()

const disposal = {
  all: undefined as Promise<void> | undefined,
}

function cacheKey(directory: string, scopeId: string) {
  return `${directory}::${scopeId}`
}

function emit(directory: string) {
  GlobalBus.emit("event", {
    directory,
    payload: {
      type: "server.instance.disposed",
      properties: {
        directory,
      },
    },
  })
}

function boot(input: {
  directory: string
  scopeId: string
  init?: () => Promise<any>
  project?: Project.Info
  worktree?: string
  vfs?: VFS
  search?: import("../util/search").SearchProvider
  paths?: InstancePaths
  config?: Record<string, unknown>
  instructions?: string[]
}) {
  return iife(async () => {
    if (input.project && input.worktree) {
      const ctx: Context = {
        directory: input.directory,
        worktree: input.worktree,
        project: input.project,
        scopeId: input.scopeId,
        vfs: input.vfs,
        search: input.search,
        paths: input.paths,
        config: input.config,
        instructions: input.instructions,
      }
      await context.provide(ctx, async () => {
        await input.init?.()
      })
      return ctx
    }

    // Need to discover project — but Project.fromDirectory uses Filesystem
    // which needs Instance.vfs. Provide a temporary context first.
    const tempCtx: Context = {
      directory: input.directory,
      worktree: input.directory,
      project: { id: "temp", path: input.directory } as any,
      scopeId: input.scopeId,
      vfs: input.vfs,
      search: input.search,
      paths: input.paths,
      config: input.config,
      instructions: input.instructions,
    }
    const { project, sandbox } = await context.provide(tempCtx, () =>
      Project.fromDirectory(input.directory),
    )
    const ctx: Context = {
      directory: input.directory,
      worktree: sandbox,
      project,
      scopeId: input.scopeId,
      vfs: input.vfs,
      search: input.search,
      paths: input.paths,
      config: input.config,
      instructions: input.instructions,
    }
    await context.provide(ctx, async () => {
      await input.init?.()
    })
    return ctx
  })
}

function track(key: string, next: Promise<Context>) {
  const task = next.catch((error) => {
    if (cache.get(key) === task) cache.delete(key)
    throw error
  })
  cache.set(key, task)
  return task
}

/** Default scope used when no explicit scopeId is provided (backward compat) */
const DEFAULT_SCOPE = "default"

export const Instance = {
  async provide<R>(input: {
    directory: string
    scopeId?: string
    init?: () => Promise<any>
    fn: () => R
    vfs?: VFS
    search?: import("../util/search").SearchProvider
    paths?: InstancePaths
    config?: Record<string, unknown>
    instructions?: string[]
  }): Promise<R> {
    const directory = Filesystem.resolve(input.directory)
    const scopeId = input.scopeId || DEFAULT_SCOPE
    const key = cacheKey(directory, scopeId)
    let existing = cache.get(key)
    if (!existing) {
      Log.Default.info("creating instance", { directory, scopeId })
      existing = track(
        key,
        boot({
          directory,
          scopeId,
          init: input.init,
          vfs: input.vfs,
          search: input.search,
          paths: input.paths,
          config: input.config,
          instructions: input.instructions,
        }),
      )
    }
    const ctx = await existing
    // Allow overriding VFS/config/instructions per provide() call
    const ctxWithOverrides =
      input.vfs || input.paths || input.config || input.instructions || input.search
        ? {
            ...ctx,
            ...(input.vfs && { vfs: input.vfs }),
            ...(input.search && { search: input.search }),
            ...(input.paths && { paths: input.paths }),
            ...(input.config && { config: input.config }),
            ...(input.instructions && { instructions: input.instructions }),
          }
        : ctx
    return context.provide(ctxWithOverrides, async () => {
      return input.fn()
    })
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },
  get scopeId() {
    return context.use().scopeId
  },
  get vfs(): VFS {
    const ctx = context.use()
    if (!ctx.vfs) throw new Error("VFS not provided. Pass a VFS implementation via Instance.provide({ vfs })")
    return ctx.vfs
  },
  get config(): Record<string, unknown> | undefined {
    return context.use().config
  },
  get search() {
    const search = context.use().search
    if (!search) throw new Error("SearchProvider is not configured for this instance")
    return search
  },
  get paths(): InstancePaths {
    const ctx = context.use()
    if (!ctx.paths) throw new Error("Paths not provided. Pass paths via Instance.provide({ paths })")
    return ctx.paths
  },
  get instructions(): string[] | undefined {
    return context.use().instructions
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Instance.worktree, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => cacheKey(Instance.directory, Instance.scopeId), init, dispose)
  },
  async reload(input: {
    directory: string
    scopeId?: string
    init?: () => Promise<any>
    project?: Project.Info
    worktree?: string
  }) {
    const directory = Filesystem.resolve(input.directory)
    const scopeId = input.scopeId || DEFAULT_SCOPE
    const key = cacheKey(directory, scopeId)
    Log.Default.info("reloading instance", { directory, scopeId })
    await Promise.all([State.dispose(key), Effect.runPromise(InstanceState.dispose(directory))])
    cache.delete(key)
    const next = track(key, boot({ ...input, directory, scopeId }))
    emit(directory)
    return await next
  },
  async dispose() {
    const key = cacheKey(Instance.directory, Instance.scopeId)
    Log.Default.info("disposing instance", { directory: Instance.directory, scopeId: Instance.scopeId })
    await Promise.all([State.dispose(key), Effect.runPromise(InstanceState.dispose(Instance.directory))])
    cache.delete(key)
    emit(Instance.directory)
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
