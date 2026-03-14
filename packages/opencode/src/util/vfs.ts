/**
 * Virtual File System (VFS) Interface
 *
 * Abstracts file system operations for opencode tools.
 * Tools use this interface via `ctx.fs` instead of direct `Filesystem.*` calls.
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
    readText(path: string): Promise<string>
    readBytes(path: string): Promise<Uint8Array>
    readDir(path: string): Promise<VFSDirEntry[]>
    write(path: string, content: string | Uint8Array): Promise<void>
    mkdir(path: string): Promise<void>
    remove(path: string): Promise<void>
}

/**
 * Default VFS implementation using Node.js fs (delegates to Filesystem utility).
 */
export function createNodeVFS(): VFS {
    // Lazy import to avoid circular dependencies
    let _fs: typeof import("./filesystem").Filesystem | undefined

    async function getFs() {
        if (!_fs) {
            const mod = await import("./filesystem")
            _fs = mod.Filesystem
        }
        return _fs
    }

    return {
        async exists(p) {
            const fs = await getFs()
            return fs.exists(p)
        },
        async stat(p) {
            const fs = await getFs()
            const s = fs.stat(p)
            if (!s) return undefined
            return {
                size: typeof s.size === "bigint" ? Number(s.size) : s.size,
                isDirectory: s.isDirectory(),
                isFile: s.isFile(),
                mtimeMs: typeof s.mtimeMs === "bigint" ? Number(s.mtimeMs) : s.mtimeMs,
            }
        },
        async readText(p) {
            const fs = await getFs()
            return fs.readText(p)
        },
        async readBytes(p) {
            const fs = await getFs()
            return fs.readBytes(p)
        },
        async readDir(p) {
            const { readdirSync } = await import("fs")
            const entries = readdirSync(p, { withFileTypes: true })
            return entries.map((e) => ({
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile(),
                isSymbolicLink: e.isSymbolicLink(),
            }))
        },
        async write(p, content) {
            const fs = await getFs()
            return fs.write(p, content)
        },
        async mkdir(p) {
            const { mkdir } = await import("fs/promises")
            await mkdir(p, { recursive: true })
        },
        async remove(p) {
            const { unlink } = await import("fs/promises")
            await unlink(p).catch(() => {})
        },
    }
}
