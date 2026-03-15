/**
 * @any-code/agent — re-exports from @any-code/opencode/agent/code-agent
 *
 * CodeAgent now lives in the opencode package for direct access to all services.
 * This package re-exports everything for backward compatibility.
 */

export {
    CodeAgent,
    type CodeAgentOptions,
    type CodeAgentProvider,
    type CodeAgentSession,
    type CodeAgentEvent,
    type CodeAgentEventType,
    type PermissionRequest,
    type PermissionReply,
    type StorageProvider,
    type Migration,
} from "@any-code/opencode/agent/code-agent"

// VFS stays here (Node-specific implementations)
export type { VirtualFileSystem, VFSStat, VFSDirEntry } from "./vfs"
export { NodeFS } from "./vfs-node"
export { NodeSearchProvider } from "./search-node"

// Git provider now comes from opencode
export { NodeGitProvider } from "@any-code/opencode/util/git"

// Storage implementations re-exported from opencode
export { BetterSqliteStorage } from "@any-code/opencode/agent/better-sqlite3-storage"
export { SqlJsStorage } from "@any-code/opencode/agent/sqljs-storage"

