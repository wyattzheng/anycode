import { Project } from "./project"
import { VFS } from "../util/vfs"
import { SearchProvider } from "../util/search"
import type { GitProvider } from "../util/git"
import type { EnvService } from "../util/env"
import type { BusService } from "../bus"
import type { SchedulerService } from "../util/scheduler"
import type { FileTimeService } from "./project"

import type { Question } from "../session/question"
import type { SessionStatus } from "../session"
import type { InstructionPrompt } from "../session/instruction"
import type { SessionPrompt } from "../session/session"


import type { Agent } from "../agent/agent"
import type { Provider } from "../provider/provider"
import type { ModelsDev } from "../provider/models"
import type { ToolRegistry } from "../tool/registry"
import type { Skill } from "../skill"




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
    search: SearchProvider
    /** Common local paths specific to this context */
    paths: InstancePaths
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

    // Phase 1+: context-dependent services (created in CodeAgent.init())
    config: Record<string, any>
    question: Question.QuestionService
    sessionStatus: SessionStatus.SessionStatusService
    instruction: InstructionPrompt.InstructionService
    sessionPrompt: SessionPrompt.SessionPromptService


    agents: Agent.AgentService
    provider: Provider.ProviderService
    modelsDev: ModelsDev.ModelsDevService
    toolRegistry: ToolRegistry.ToolRegistryService
    skill: Skill.SkillService



}
