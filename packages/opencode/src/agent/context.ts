import { Project } from "../project/project"
import { VFS } from "../util/vfs"
import { SearchProvider } from "../util/search"
import type { GitProvider } from "../util/git"
import type { EnvService } from "../util/env"
import type { BusService } from "../bus"
import type { SchedulerService } from "../util/scheduler"
import type { FileTimeService } from "../file/time"

export interface InstancePaths {
    data: string
    bin: string
    log: string
    cache: string
    config: string
    state: string
    home: string
}

export interface AgentContext {
    /** Current working directory for the agent execution */
    directory: string
    /** The resolved root of the project/worktree */
    worktree: string
    /** Project metadata and id */
    project: Project.Info
    /** Virtual File System implementation */
    fs: VFS
    /** Git command executor */
    git: GitProvider
    /** Search Provider implementation */
    search?: SearchProvider
    /** Common local paths specific to this context */
    paths: InstancePaths
    /** Function to determine if a path is considered within the working scope */
    containsPath: (filepath: string) => boolean
    /** Extracted config overrides or metadata (optional) */
    config?: Record<string, unknown>
    /** Instructions overrides (optional) */
    instructions?: string[]
    /** Database client — set during init, used for all DB operations */
    db: any
    /** Per-instance module state. Modules use getState() with a unique key for lazy init. */
    state: Map<any, any>

    // ── Service instances ──────────────────────────────────────────
    /** Environment variable service */
    env: EnvService
    /** Event bus service */
    bus: BusService
    /** Task scheduler service */
    scheduler: SchedulerService
    /** File read-time tracking + write locks */
    fileTime: FileTimeService
}

/**
 * Get or lazily initialize module-scoped state on the context.
 * Each module uses a unique key (typically a Symbol) to avoid collisions.
 */
export function getState<T>(context: AgentContext, key: any, init: () => T): T {
    if (context.state.has(key)) return context.state.get(key)!
    const s = init()
    context.state.set(key, s)
    return s
}
