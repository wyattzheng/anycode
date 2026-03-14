/**
 * NodeSearchProvider — Node.js implementation of SearchProvider.
 *
 * - grep(): spawns system `grep -rnH` (always available on Unix/macOS)
 */
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import type { SearchProvider, GrepMatch } from "@any-code/opencode/util/search"

export class NodeSearchProvider implements SearchProvider {
    async grep(options: {
        pattern: string
        path: string
        include?: string
        maxLineLength?: number
        signal?: AbortSignal
    }): Promise<GrepMatch[]> {
        options.signal?.throwIfAborted()

        return new Promise((resolve) => {
            // Use system grep: -r (recursive), -n (line numbers), -H (filenames)
            const args = ["-rnH", "--color=never"]

            if (options.include) {
                args.push(`--include=${options.include}`)
            }

            // Exclude .git directory
            args.push("--exclude-dir=.git")

            // Use -E for extended regex (more compatible with ripgrep patterns)
            args.push("-E")

            args.push("--", options.pattern, options.path)

            const proc = spawn("grep", args, {
                stdio: ["ignore", "pipe", "pipe"],
                signal: options.signal,
            })

            let output = ""
            proc.stdout.on("data", (data: Buffer) => {
                output += data.toString()
            })

            proc.on("close", () => {
                const results: GrepMatch[] = []
                for (const line of output.split("\n")) {
                    if (!line.trim()) continue
                    // grep output format: file:line:content
                    const match = line.match(/^(.+?):(\d+):(.*)$/)
                    if (match) {
                        let content = match[3]
                        if (options.maxLineLength !== undefined && content.length > options.maxLineLength) {
                            content = content.slice(0, options.maxLineLength) + "..."
                        }
                        results.push({
                            file: match[1],
                            line: parseInt(match[2], 10),
                            column: 0,
                            content,
                        })
                    }
                }
                resolve(results)
            })

            proc.on("error", () => resolve([]))
        })
    }

    async listFiles(options: {
        cwd: string
        glob?: string[]
        hidden?: boolean
        follow?: boolean
        maxDepth?: number
        limit?: number
        signal?: AbortSignal
    }): Promise<string[]> {
        options.signal?.throwIfAborted()

        const showHidden = options.hidden === true
        const results: string[] = []
        const limit = options.limit ?? Infinity

        // Parse glob patterns into include/exclude
        const excludePatterns: string[] = [".git"]
        const includePatterns: string[] = []
        for (const g of options.glob ?? []) {
            if (g.startsWith("!")) {
                // Remove trailing * and / for directory matching
                excludePatterns.push(g.slice(1).replace(/[/*]+$/, ""))
            } else {
                includePatterns.push(g)
            }
        }

        const walk = async (dir: string, depth: number): Promise<void> => {
            if (results.length >= limit) return
            if (options.maxDepth !== undefined && depth > options.maxDepth) return
            options.signal?.throwIfAborted()

            let entries: import("fs").Dirent[]
            try {
                entries = await fs.readdir(dir, { withFileTypes: true })
            } catch {
                return
            }

            for (const entry of entries) {
                if (results.length >= limit) return

                const name = entry.name
                // Skip hidden files unless requested
                if (!showHidden && name.startsWith(".")) continue

                const fullPath = path.join(dir, name)
                const relativePath = path.relative(options.cwd, fullPath)

                // Check excludes
                if (excludePatterns.some((p: string) => relativePath.startsWith(p) || name === p)) continue

                const isDir = entry.isDirectory() || (options.follow && entry.isSymbolicLink())

                if (isDir) {
                    await walk(fullPath, depth + 1)
                } else if (entry.isFile()) {
                    // Check include patterns (simple glob: *.ext matching)
                    if (includePatterns.length > 0) {
                        const matches = includePatterns.some((p: string) => simpleGlobMatch(name, p))
                        if (!matches) continue
                    }
                    results.push(relativePath)
                }
            }
        }

        await walk(options.cwd, 0)
        return results
    }
}

/** Simple glob matching: supports *.ext and *.{ext1,ext2} patterns */
function simpleGlobMatch(filename: string, pattern: string): boolean {
    if (pattern === "*") return true
    if (pattern.startsWith("*.")) {
        const ext = pattern.slice(1) // ".ts" or ".{ts,tsx}"
        if (ext.startsWith(".{") && ext.endsWith("}")) {
            const exts = ext.slice(2, -1).split(",")
            return exts.some((e) => filename.endsWith(`.${e}`))
        }
        return filename.endsWith(ext)
    }
    // Fallback: exact match
    return filename === pattern
}
