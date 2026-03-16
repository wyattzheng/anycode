import { Project } from "./project"
import { VFS } from "./util/vfs"
import { SearchProvider } from "./util/search"
import type { GitProvider } from "./util/git"
import type { EnvService } from "./util/env"
import type { BusService } from "./bus"
import type { SchedulerService } from "./util/scheduler"
import type { FileTimeService } from "./project"
import type { MemoryService } from "./memory"

import type { SessionStatus } from "./session"

import type { SessionPrompt } from "./session/session"


import type { Agent } from "./agent"
import type { Provider } from "./provider/provider"
import type { ModelsDev } from "./provider/models"
import type { ToolRegistry } from "./tool/registry"
import type { Skill } from "./skill"



/** Abstraction over child_process for bash tool execution */
export interface ShellProcess {
    readonly pid: number | undefined
    readonly exitCode: number | null
    readonly stdout: { on(event: "data", cb: (chunk: Buffer) => void): void } | null
    readonly stderr: { on(event: "data", cb: (chunk: Buffer) => void): void } | null
    once(event: "exit", cb: (code: number | null) => void): void
    once(event: "error", cb: (err: Error) => void): void
    kill(signal?: string): boolean
}

export interface ShellProvider {
    /** Platform identifier (e.g. "darwin", "linux", "win32") */
    platform: string
    /** Spawn a command in the shell */
    spawn(command: string, opts: {
        cwd: string
        env: Record<string, string | undefined>
    }): ShellProcess
    /** Kill a process and all its children */
    kill(proc: ShellProcess, opts?: { exited?: () => boolean }): Promise<void>
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
    /** Shell execution (spawn/kill) */
    shell: ShellProvider
    /** Search Provider implementation */
    search: SearchProvider
    /** Base data directory for this agent instance */
    dataPath: string
    /** Function to determine if a path is considered within the working scope */
    containsPath: (filepath: string) => boolean
    /** Injected config overrides (optional, used by CodeAgent to bypass file-based config) */
    configOverrides?: Record<string, unknown>
    /** Instructions overrides (optional) */
    instructions?: string[]
    /** Database client — set during init, used for all DB operations */
    db: any

    // ── Service instances ──────────────────────────────────────────
    // Phase 0: stateless services (created in CodeAgent constructor)
    env: EnvService
    bus: BusService
    scheduler: SchedulerService
    fileTime: FileTimeService
    memory: MemoryService

    // Phase 1+: context-dependent services (created in CodeAgent.init())
    config: Record<string, any>
    sessionStatus: SessionStatus.Info

    sessionPrompt: SessionPrompt.SessionPromptService


    agents: Agent.AgentService
    provider: Provider.ProviderService
    modelsDev: ModelsDev.ModelsDevService
    toolRegistry: ToolRegistry.ToolRegistryService
    skill: Skill.SkillService


}
