/**
 * Virtual File System (VFS) Interface
 *
 * Abstracts file system operations so the agent can work with
 * different backends: Node.js fs, in-memory, remote (WebSocket), etc.
 *
 * This is Phase 1 of decoupling opencode from Node.js fs.
 * The interface mirrors opencode's Filesystem utility methods
 * used by tools (write, read, edit, grep, glob, bash).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface VFSStat {
    /** File size in bytes */
    size: number
    /** True if entry is a directory */
    isDirectory: boolean
    /** True if entry is a file */
    isFile: boolean
    /** Last modified time (ms since epoch) */
    mtimeMs: number
}

export interface VFSDirEntry {
    /** Entry name (not full path) */
    name: string
    /** True if directory */
    isDirectory: boolean
    /** True if file */
    isFile: boolean
}

export interface GrepOptions {
    maxResults?: number
    include?: string[]
}

export interface GrepMatch {
    file: string
    line: number
    column: number
    content: string
}

/**
 * Virtual File System interface.
 *
 * All paths are absolute. Implementations should handle path normalization.
 */
export interface VirtualFileSystem {
    // ── Read operations ────────────────────────────────────────────────

    /** Check if a path exists */
    exists(path: string): Promise<boolean>

    /** Get file/directory stats, returns undefined if not found */
    stat(path: string): Promise<VFSStat | undefined>

    /** Read file as UTF-8 text */
    readText(path: string): Promise<string>

    /** Read file as binary */
    readBytes(path: string): Promise<Uint8Array>

    /** List directory entries */
    readDir(path: string): Promise<VFSDirEntry[]>

    // ── Write operations ───────────────────────────────────────────────

    /** Write text or binary content to a file. Creates parent dirs if needed. */
    write(path: string, content: string | Uint8Array): Promise<void>

    /** Create directory (and parents). No-op if already exists. */
    mkdir(path: string): Promise<void>

    /** Remove a file. No-op if not found. */
    remove(path: string): Promise<void>

}
