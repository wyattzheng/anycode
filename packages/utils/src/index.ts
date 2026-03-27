/**
 * @any-code/utils — Node.js platform implementations
 *
 * Provides concrete implementations of VFS, Search, and Storage
 * interfaces for the Node.js platform.
 */

// Logger
export type { Logger } from "./logger"
export { consoleLogger } from "./logger"

// NoSQL DB interfaces & implementation
export type { NoSqlDb, RawSqliteDb, Filter, FindManyOptions } from "./nosql"
export { SqliteNoSqlDb } from "./nosql"

// Search interfaces
export type { SearchProvider, GrepMatch } from "./search"

// Storage interfaces
export type { StorageProvider, Migration } from "./storage"

// VFS interfaces
export type { VirtualFileSystem, VFSStat, VFSDirEntry, GrepOptions, GrepMatch as VFSGrepMatch } from "./vfs"

// ChatAgent interfaces
export type { IChatAgent, ChatAgentConfig, ChatAgentEvent } from "./chat-agent"

// Implementations
export { NodeFS } from "./vfs-node"
export { NodeSearchProvider } from "./search-node"
export { SqlJsStorage } from "./storage-sqljs"
export { getDefaultMigrations } from "./migrations"

// LLM types
export type {
  LLMStreamChunk,
  LLMStreamResult,
  LLMToolDef,
  LLMToolCallOptions,
  LLMMessage,
  LLMSystemMessage,
  LLMUserMessage,
  LLMAssistantMessage,
  LLMToolMessage,
  LLMTextPart,
  LLMImagePart,
  LLMFilePart,
  LLMReasoningPart,
  LLMToolCallPart,
  LLMToolResultPart,
  LLMUserContent,
  LLMAssistantContent,
  LLMToolContent,
  LLMUsage,
  LLMStreamInput,
} from "./llm"
