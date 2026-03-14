/**
 * NodeFS — Node.js implementation of VirtualFileSystem
 *
 * Default VFS backend. Delegates to Node.js `fs` and spawns
 * `ripgrep` for grep operations, matching opencode's behavior.
 */
import fs from "fs/promises"
import { existsSync, statSync, readdirSync } from "fs"
import path from "path"
import { spawn } from "child_process"
import type { VirtualFileSystem, VFSStat, VFSDirEntry, GrepOptions, GrepMatch } from "./vfs"

export class NodeFS implements VirtualFileSystem {
    async exists(p: string): Promise<boolean> {
        return existsSync(p)
    }

    async stat(p: string): Promise<VFSStat | undefined> {
        try {
            const s = statSync(p)
            return {
                size: typeof s.size === "bigint" ? Number(s.size) : s.size,
                isDirectory: s.isDirectory(),
                isFile: s.isFile(),
                mtimeMs: s.mtimeMs,
            }
        } catch {
            return undefined
        }
    }

    async readText(p: string): Promise<string> {
        return fs.readFile(p, "utf-8")
    }

    async readBytes(p: string): Promise<Uint8Array> {
        return fs.readFile(p)
    }

    async readDir(p: string): Promise<VFSDirEntry[]> {
        const entries = readdirSync(p, { withFileTypes: true })
        return entries.map((e) => ({
            name: e.name,
            isDirectory: e.isDirectory(),
            isFile: e.isFile(),
        }))
    }

    async write(p: string, content: string | Uint8Array): Promise<void> {
        try {
            await fs.writeFile(p, content)
        } catch (e: any) {
            if (e?.code === "ENOENT") {
                await fs.mkdir(path.dirname(p), { recursive: true })
                await fs.writeFile(p, content)
                return
            }
            throw e
        }
    }

    async mkdir(p: string): Promise<void> {
        await fs.mkdir(p, { recursive: true })
    }

    async remove(p: string): Promise<void> {
        await fs.unlink(p).catch(() => {})
    }

    async grep(pattern: string, searchPath: string, options?: GrepOptions): Promise<GrepMatch[]> {
        return new Promise((resolve) => {
            const args = [
                "--json",
                "--line-number",
                "--column",
                "--no-heading",
                ...(options?.maxResults ? ["--max-count", String(options.maxResults)] : []),
                ...(options?.include?.flatMap((g: string) => ["--glob", g]) ?? []),
                pattern,
                searchPath,
            ]

            const rg = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] })
            let output = ""

            rg.stdout.on("data", (data: Buffer) => {
                output += data.toString()
            })

            rg.on("close", () => {
                const results: GrepMatch[] = []
                for (const line of output.split("\n")) {
                    if (!line.trim()) continue
                    try {
                        const parsed = JSON.parse(line)
                        if (parsed.type === "match") {
                            results.push({
                                file: parsed.data.path.text,
                                line: parsed.data.line_number,
                                column: parsed.data.submatches?.[0]?.start ?? 0,
                                content: parsed.data.lines.text.trimEnd(),
                            })
                        }
                    } catch {
                        // skip non-JSON lines
                    }
                }
                resolve(results)
            })

            rg.on("error", () => resolve([]))
        })
    }

    async glob(pattern: string, searchPath: string): Promise<string[]> {
        // Use Node.js fs.glob (available in Node 22+) or fall back to manual walk
        const { glob: fsGlob } = await import("fs/promises").catch(() => ({ glob: undefined }))
        if (fsGlob) {
            try {
                const results: string[] = []
                for await (const entry of (fsGlob as any)(pattern, { cwd: searchPath })) {
                    results.push(path.resolve(searchPath, entry))
                }
                return results
            } catch {
                // fallback
            }
        }

        // Fallback: use ripgrep --files with glob
        return new Promise((resolve) => {
            const rg = spawn("rg", ["--files", "--glob", pattern, searchPath], {
                stdio: ["ignore", "pipe", "pipe"],
            })
            let output = ""
            rg.stdout.on("data", (data: Buffer) => {
                output += data.toString()
            })
            rg.on("close", () => {
                resolve(
                    output
                        .split("\n")
                        .map((l) => l.trim())
                        .filter(Boolean),
                )
            })
            rg.on("error", () => resolve([]))
        })
    }
}
