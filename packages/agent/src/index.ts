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
} from "./agent"

// Session & schema
export { Session, SessionService } from "./session"
export { SessionPrompt, SessionPromptService, type ISessionPromptService } from "./session/session"
export { SessionID, MessageID, PartID } from "./session/schema"


// Memory
export { MessageV2 } from "./memory/message-v2"

// Tools
export { Tool } from "./tool/tool"
export { ToolRegistryService, type IToolRegistryService } from "./tool/registry"

// Provider
export { Provider, ProviderID, ModelID } from "@any-code/provider"

// Bus & logging
export { Log } from "./util/log"

// Storage (re-exported from @any-code/utils)
export {
  type NoSqlDb,
  type RawSqliteDb,
  type Filter,
  type FindManyOptions,
  SqliteNoSqlDb,
} from "@any-code/utils"
export { NotFoundError } from "./util/error"

// Project
export {
  type Project,
  FileTimeService,
  type ProjectID,
  Protected,
  FileIgnore,
} from "./project"

// Context interfaces
export type { TerminalProvider, ShellProvider, PreviewProvider } from "./context"

// Util — search, git, markdown
export type { SearchProvider, GrepMatch } from "@any-code/utils"
export type { GitProvider, GitResult } from "./util/git"
export { ConfigMarkdown } from "./util/markdown"

// Prompt
export { SystemPrompt } from "./prompt"

// Settings (type-only — loading is done by the host)
export type { Settings } from "./settings"

// Node.js implementations (re-export from utils)
export { NodeFS, NodeSearchProvider } from "@any-code/utils"
