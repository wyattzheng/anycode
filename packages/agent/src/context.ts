import { Project } from "./project"
import { VFS } from "./util/vfs"
import { SearchProvider } from "./util/search"
import type { GitProvider } from "./util/git"
import type { EnvService } from "./util/env"
import type { Log } from "./util/log"

import type { SchedulerService } from "./util/scheduler"
import type { FileTimeService } from "./project"
import type { MemoryService } from "./memory"
import type { ICompactionService } from "./memory/compaction"

import type { SessionStatus } from "./session"
import type { SessionService } from "./session"

import type { SessionPrompt } from "./session/session"
import type { ISystemPrompt } from "./prompt"



import type { Provider } from "@any-code/provider"
import type { IToolRegistryService } from "./tool/registry"
import type { Tool } from "./tool/tool"
import type { ISkillService } from "./skill"
import type { Settings } from "./settings"


/** Abstraction over setting the preview target for the frontend */
export interface PreviewProvider {
  /** Set the local URL to reverse-proxy for preview */
  setPreviewTarget(forwardedLocalUrl: string): void
}

/** Abstraction over the shared user terminal (PTY) for agent tools */
export interface TerminalProvider {
  /** Create a new terminal. Throws if one already exists. */
  create(): void
  /** Destroy the current terminal. Throws if none exists. */
  destroy(): void
  /** Write input to the terminal. Throws if no terminal exists. */
  write(data: string): void
  /** Read the last `lines` lines from the terminal buffer. Throws if no terminal exists. */
  read(lines: number): string
  /** Whether a terminal currently exists */
  exists(): boolean
}


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
  /** Shared terminal (PTY) for agent ↔ user interaction */
  terminal: TerminalProvider
  /** Preview URL provider for reverse-proxying local services */
  preview: PreviewProvider
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

  /** Extra tools injected from outside (set_directory, terminal, preview, etc.) */
  tools?: Tool.Info[]

  // ── Service instances ──────────────────────────────────────────
  // Phase 0: stateless services (created in CodeAgent constructor)
  env: EnvService
  session: SessionService
  scheduler: SchedulerService
  fileTime: FileTimeService
  memory: MemoryService
  compaction: ICompactionService

  // Phase 1+: context-dependent services (created in CodeAgent.init())
  config: Record<string, any>
  sessionStatus: SessionStatus.Info

  sessionPrompt: SessionPrompt.SessionPromptService
  systemPrompt: ISystemPrompt

  provider: Provider.ProviderService
  toolRegistry: IToolRegistryService
  skill: ISkillService

  /** User settings loaded from ~/.anycode/settings.json */
  settings: Settings.Info

  /** Multi-instance logger — each CodeAgent owns its own Log */
  log: Log
}
