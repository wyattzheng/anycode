/**
 * In-Memory VFS implementation for testing.
 * Records all file operations so tests can assert what was written.
 */
import type { VirtualFileSystem, VFSStat, VFSDirEntry } from "../../src/vfs"
import * as path from "path"

export class InMemoryFS implements VirtualFileSystem {
    /** In-memory file store: path → content (string or Uint8Array) */
    private files = new Map<string, string | Uint8Array>()
    /** Tracks directories that were explicitly created */
    private dirs = new Set<string>()

    // ── Internal ──

    entries(): IterableIterator<[string, string | Uint8Array]> {
        return this.files.entries()
    }

    keys(): IterableIterator<string> {
        return this.files.keys()
    }

    // ── Read operations ──

    async exists(p: string): Promise<boolean> {
        return this.files.has(p) || this.dirs.has(p)
    }

    async stat(p: string): Promise<VFSStat | undefined> {
        if (this.dirs.has(p)) {
            return {
                size: 0,
                isDirectory: true,
                isFile: false,
                mtimeMs: Date.now(),
            }
        }
        const content = this.files.get(p)
        if (content === undefined) return undefined
        const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength
        return {
            size,
            isDirectory: false,
            isFile: true,
            mtimeMs: Date.now(),
        }
    }

    async readText(p: string): Promise<string> {
        const content = this.files.get(p)
        if (content === undefined) {
            const err = new Error(`ENOENT: no such file: ${p}`) as NodeJS.ErrnoException
            err.code = "ENOENT"
            throw err
        }
        return typeof content === "string" ? content : new TextDecoder().decode(content)
    }

    async readBytes(p: string): Promise<Uint8Array> {
        const content = this.files.get(p)
        if (content === undefined) {
            const err = new Error(`ENOENT: no such file: ${p}`) as NodeJS.ErrnoException
            err.code = "ENOENT"
            throw err
        }
        return typeof content === "string" ? new TextEncoder().encode(content) : content
    }

    async readDir(p: string): Promise<VFSDirEntry[]> {
        const entries: VFSDirEntry[] = []
        const prefix = p.endsWith("/") ? p : p + "/"
        const seen = new Set<string>()

        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length)
                const name = rest.split("/")[0]
                if (!seen.has(name)) {
                    seen.add(name)
                    entries.push({
                        name,
                        isDirectory: rest.includes("/"),
                        isFile: !rest.includes("/"),
                    })
                }
            }
        }

        for (const key of this.dirs) {
            if (key.startsWith(prefix)) {
                const rest = key.slice(prefix.length)
                const name = rest.split("/")[0]
                if (!seen.has(name)) {
                    seen.add(name)
                    entries.push({ name, isDirectory: true, isFile: false })
                }
            }
        }

        return entries
    }

    // ── Write operations ──

    async write(p: string, content: string | Uint8Array): Promise<void> {
        // Auto-create parent directories
        const dir = path.dirname(p)
        if (dir !== p) {
            await this.mkdir(dir)
        }
        this.files.set(p, content)
    }

    async mkdir(p: string): Promise<void> {
        // Recursively create all parent dirs
        const parts = p.split("/").filter(Boolean)
        let current = ""
        for (const part of parts) {
            current += "/" + part
            this.dirs.add(current)
        }
    }

    async remove(p: string): Promise<void> {
        this.files.delete(p)
        this.dirs.delete(p)
    }


    // ── Test helpers ──

    /** Get the raw content of a file */
    getFile(p: string): string | Uint8Array | undefined {
        return this.files.get(p)
    }

    /** Get text content of a file */
    getFileText(p: string): string | undefined {
        const content = this.files.get(p)
        if (content === undefined) return undefined
        return typeof content === "string" ? content : new TextDecoder().decode(content)
    }

    /** Get all written file paths */
    getWrittenPaths(): string[] {
        return Array.from(this.files.keys())
    }

    /** Check if a file exists in memory */
    hasFile(p: string): boolean {
        return this.files.has(p)
    }

    /** Clear all files and directories */
    clear(): void {
        this.files.clear()
        this.dirs.clear()
    }
}
