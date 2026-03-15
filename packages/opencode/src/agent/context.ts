import { Project } from "../project/project"
import { VFS } from "../util/vfs"
import { SearchProvider } from "../util/search"
import { State } from "../project/state"
import type { GitProvider } from "../util/git"

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
    /** Unique scope identifier for state isolation */
    scopeId: string
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
}

/**
 * Creates a scoped state initializer bound to an AgentContext's scopeId.
 * Replaces the previous `Instance.state` singleton pattern.
 */
export function createScopedState<S>(
    init: (context: AgentContext) => S,
    dispose?: (state: Awaited<S>) => Promise<void>
): (context: AgentContext) => S {
    return State.create((context: AgentContext) => `${context?.directory ?? 'global'}::${context?.scopeId ?? 'default'}`, init, dispose)
}
