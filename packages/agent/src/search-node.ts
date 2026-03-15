/**
 * NodeSearchProvider — Node.js implementation of SearchProvider.
 *
 * - grep(): spawns system `grep -rnH` (always available on Unix/macOS)
 */
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import type { SearchProvider, GrepMatch } from "@any-code/opencode"

export class NodeSearchProvider implements SearchProvider {
    async grep(options: {
        pattern: string
        path: string
        include?: string
        maxLineLength?: number
        signal?: AbortSignal
    }): Promise<GrepMatch[]> {
        options.signal?.throwIfAborted()

        return new Promise((resolve, reject) => {
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

            proc.on("error", (error: Error) => {
                reject(error)
            })
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

    async tree(options: { cwd: string; limit?: number; signal?: AbortSignal }): Promise<string> {
        const limit = options.limit ?? 50
        const files = await this.listFiles({ cwd: options.cwd, signal: options.signal })
        interface Node {
            name: string
            children: Map<string, Node>
        }

        function dir(node: Node, name: string) {
            const existing = node.children.get(name)
            if (existing) return existing
            const next = { name, children: new Map() }
            node.children.set(name, next)
            return next
        }

        const root: Node = { name: "", children: new Map() }
        for (const file of files) {
            if (file.includes(".opencode")) continue
            const parts = file.split(/[\/\\]/)
            if (parts.length < 2) continue
            let node = root
            for (const part of parts.slice(0, -1)) {
                node = dir(node, part)
            }
        }

        function count(node: Node): number {
            let total = 0
            for (const child of node.children.values()) {
                total += 1 + count(child)
            }
            return total
        }

        const total = count(root)
        const lines: string[] = []
        const queue: { node: Node; path: string }[] = []
        
        for (const child of Array.from(root.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
            queue.push({ node: child, path: child.name })
        }

        let used = 0
        for (let i = 0; i < queue.length && used < limit; i++) {
            const { node, path: p } = queue[i]
            lines.push(p)
            used++
            for (const child of Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name))) {
                queue.push({ node: child, path: `${p}/${child.name}` })
            }
        }

        if (total > used) lines.push(`[${total - used} truncated]`)

        return lines.join("\n")
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
