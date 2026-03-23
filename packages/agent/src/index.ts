// OpenCode Core - Library Entry Point
// Forked from https://github.com/anomalyco/opencode
// Stripped of CLI/TUI, exposed as library for programmatic use

// Core agent
export {
  CodeAgent,
  type CodeAgentOptions,
  type CodeAgentProvider,
  type CodeAgentSession,
  type CodeAgentEvent,
  type CodeAgentEventType,
  type StorageProvider,
  type Migration,
} from "./code-agent"

// Session & schema
export { Session, SessionService } from "./session"
export { SessionPrompt } from "./session/session"
export { SessionID, MessageID, PartID } from "./session/schema"

// LLM
export { LLMRunner, LLM } from "./llm-runner"

// Memory
export { MessageV2 } from "./memory/message-v2"

// Tools
export { Tool } from "./tool/tool"
export { ToolRegistry } from "./tool/registry"
export { SetWorkingDirectoryTool } from "./tool/set-directory"
export { TerminalWriteTool } from "./tool/terminal-write"
export { TerminalReadTool } from "./tool/terminal-read"
export { SetPreviewUrlTool } from "./tool/set-preview-url"

// Provider
export { Provider } from "./provider/provider"
export { ProviderID, ModelID } from "./provider/schema"



// Bus & logging

export { Log } from "./util/log"

// Storage
export {
  Database,
  type NoSqlDb,
  type RawSqliteDb,
  type Filter,
  type FindManyOptions,
  SqliteNoSqlDb,
  NotFoundError,
  Timestamps,
  Storage,
  ProjectTable,
  SessionTable, MessageTable, PartTable, TodoTable,
} from "./storage"

// Project
export {
  Project,
  FileTimeService,
  type ProjectID,
  Protected,
  FileIgnore,
} from "./project"

// Skill
export { Skill, Discovery } from "./skill"

// Context interfaces
export type { TerminalProvider, ShellProvider, PreviewProvider } from "./context"

// Util — search, git, markdown
export type { SearchProvider, GrepMatch } from "./util/search"
export type { GitProvider, GitResult } from "./util/git"
export { ConfigMarkdown } from "./util/markdown"

// Prompt
export { SystemPrompt } from "./prompt"

// Settings (type-only — loading is done by the host)
export type { Settings } from "./settings"

// Node.js implementations (used by tests and server)
export { NodeFS } from "./vfs-node"
export { NodeSearchProvider } from "./search-node"
export { SqlJsStorage } from "./storage-sqljs"
