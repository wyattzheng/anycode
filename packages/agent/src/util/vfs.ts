/**
 * Virtual File System (VFS) Interface
 *
 * Abstracts file system operations for opencode tools.
 * The VFS instance is injected via Instance.provide({ vfs })
 * and accessed via Instance.vfs.
 *
 * Filesystem (util/filesystem.ts) automatically delegates to
 * the injected VFS when one is available, so existing code
 * using Filesystem.* works without changes.
 */

export interface VFSStat {
    size: number
    isDirectory: boolean
    isFile: boolean
    mtimeMs: number
}

export interface VFSDirEntry {
    name: string
    isDirectory: boolean
    isFile: boolean
    isSymbolicLink?: boolean
}

export interface VFS {
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<VFSStat | undefined>
    isDir(path: string): Promise<boolean>
    readText(path: string): Promise<string>
    readBytes(path: string): Promise<Uint8Array>
    readJson<T = any>(path: string): Promise<T>
    readDir(path: string): Promise<VFSDirEntry[]>
    write(path: string, content: string | Uint8Array): Promise<void>
    writeJson(path: string, data: unknown): Promise<void>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
    glob(pattern: string, options: {
        cwd?: string
        absolute?: boolean
        dot?: boolean
        follow?: boolean
        nodir?: boolean
    }): Promise<string[]>
}
