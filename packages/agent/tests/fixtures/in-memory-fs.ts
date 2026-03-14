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

    async glob(pattern: string, options: {
        cwd?: string
        absolute?: boolean
        dot?: boolean
        follow?: boolean
        nodir?: boolean
    } = {}): Promise<string[]> {
        const cwd = options.cwd ?? "/"
        const cwdPrefix = cwd.endsWith("/") ? cwd : cwd + "/"
        const results: string[] = []

        for (const filePath of this.files.keys()) {
            if (!filePath.startsWith(cwdPrefix) && filePath !== cwd) continue

            const relativePath = filePath.slice(cwdPrefix.length)
            if (!relativePath) continue

            // Skip hidden files unless dot is true
            if (!options.dot && relativePath.split("/").some(p => p.startsWith("."))) continue

            // Simple glob matching
            if (simpleGlobMatchPath(relativePath, pattern)) {
                results.push(options.absolute ? filePath : relativePath)
            }
        }

        // Also check directories if nodir is not set
        if (!options.nodir) {
            for (const dirPath of this.dirs) {
                if (!dirPath.startsWith(cwdPrefix)) continue
                const relativePath = dirPath.slice(cwdPrefix.length)
                if (!relativePath) continue
                if (!options.dot && relativePath.split("/").some(p => p.startsWith("."))) continue
                if (simpleGlobMatchPath(relativePath, pattern)) {
                    results.push(options.absolute ? dirPath : relativePath)
                }
            }
        }

        return results
    }
}

/**
 * Match a relative file path against a glob pattern.
 * Supports: *, **, ?, {a,b}, and *.ext patterns.
 */
function simpleGlobMatchPath(filepath: string, pattern: string): boolean {
    // Collect brace expansions and glob tokens, replace with numbered placeholders,
    // then escape regex chars, then restore placeholders as regex equivalents.
    const placeholders: string[] = []
    function ph(regexPart: string): string {
        const idx = placeholders.length
        placeholders.push(regexPart)
        return `\0PH${idx}\0`
    }

    let work = pattern
    // 1. Replace {a,b,c} with placeholder for (a|b|c)
    work = work.replace(/\{([^}]+)\}/g, (_m, alts: string) =>
        ph(`(${alts.split(",").map(a => a.trim()).join("|")})`)
    )
    // 2. Replace ** with placeholder for .*
    work = work.replace(/\*\*/g, ph(".*"))
    // 3. Replace * with placeholder for [^/]*
    work = work.replace(/\*/g, ph("[^/]*"))
    // 4. Replace ? with placeholder for [^/]
    work = work.replace(/\?/g, ph("[^/]"))
    // 5. Escape remaining regex-special chars
    work = work.replace(/[.+^$|\\()[\]{}]/g, "\\$&")
    // 6. Restore all placeholders
    work = work.replace(/\0PH(\d+)\0/g, (_m, idx) => placeholders[parseInt(idx)])

    return new RegExp(`^${work}$`).test(filepath)
}
