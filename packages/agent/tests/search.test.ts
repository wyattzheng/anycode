import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { NodeSearchProvider } from "../src/search-node"
import { InMemorySearchProvider } from "./fixtures/search-memory"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import { createTempDir, cleanupTempDir } from "./setup"
import type { SearchProvider } from "@any-code/opencode/util/search"
import fs from "fs/promises"
import path from "path"

describe("Search Providers", () => {
    describe("NodeSearchProvider", () => {
        let tmpDir: string
        let provider: NodeSearchProvider

        beforeAll(async () => {
            tmpDir = createTempDir("node-search-")
            provider = new NodeSearchProvider()

            // Setup files
            await fs.mkdir(path.join(tmpDir, "src", "core"), { recursive: true })
            await fs.mkdir(path.join(tmpDir, "src", "utils"), { recursive: true })
            await fs.mkdir(path.join(tmpDir, ".git"), { recursive: true }) // to test exclude
            
            await fs.writeFile(path.join(tmpDir, "src", "core", "index.ts"), "export const CORE = true;\n// match-me node")
            await fs.writeFile(path.join(tmpDir, "src", "utils", "helper.ts"), "export function help() {}\n// match-me node again")
            await fs.writeFile(path.join(tmpDir, "src", "core", "test.md"), "# Test\n// match-me node")
            await fs.writeFile(path.join(tmpDir, ".git", "config"), "[core]\nbare = false\n// match-me node")
            await fs.writeFile(path.join(tmpDir, ".hidden"), "hidden file")
        })

        afterAll(() => {
            cleanupTempDir(tmpDir)
        })

        searchProviderTests(() => ({ provider, workspace: tmpDir, isNode: true }))
    })

    describe("InMemorySearchProvider", () => {
        let tmpDir: string
        let memfs: InMemoryFS
        let provider: InMemorySearchProvider

        beforeAll(async () => {
            tmpDir = "/virtual-workspace" // absolute virtual path
            memfs = new InMemoryFS()
            provider = new InMemorySearchProvider(memfs)

            // Setup files in vfs
            await memfs.write(path.join(tmpDir, "src", "core", "index.ts"), "export const CORE = true;\n// match-me in-memory")
            await memfs.write(path.join(tmpDir, "src", "utils", "helper.ts"), "export function help() {}\n// match-me in-memory again")
            await memfs.write(path.join(tmpDir, "src", "core", "test.md"), "# Test\n// match-me in-memory")
            await memfs.write(path.join(tmpDir, ".git", "config"), "[core]\nbare = false\n// match-me in-memory")
            await memfs.write(path.join(tmpDir, ".hidden"), "hidden file")
        })

        searchProviderTests(() => ({ provider, workspace: tmpDir, isNode: false }))
    })

    function searchProviderTests(setup: () => { provider: SearchProvider, workspace: string, isNode: boolean }) {
        it("should list all non-hidden files by default", async () => {
            const { provider, workspace } = setup()
            const files = await provider.listFiles({ cwd: workspace })
            
            expect(files.length).toBe(3)
            expect(files).toContain(path.normalize("src/core/index.ts"))
            expect(files).toContain(path.normalize("src/utils/helper.ts"))
            expect(files).toContain(path.normalize("src/core/test.md"))
        })

        it("should list hidden files if requested", async () => {
            const { provider, workspace } = setup()
            const files = await provider.listFiles({ cwd: workspace, hidden: true })
            
            // Should contain .hidden, but NOT .git files (as .git is typically hard-excluded, our Node/Mem setups do that)
            expect(files).toContain(".hidden")
            expect(files).not.toContain(path.normalize(".git/config"))
        })

        it("should filter listed files by exact glob patterns", async () => {
            const { provider, workspace } = setup()
            const files = await provider.listFiles({ cwd: workspace, glob: ["*.ts"] })
            
            expect(files.length).toBe(2)
            expect(files).toContain(path.normalize("src/core/index.ts"))
            expect(files).toContain(path.normalize("src/utils/helper.ts"))
        })

        it("should exclude directories using ! pattern", async () => {
            const { provider, workspace } = setup()
            const files = await provider.listFiles({ cwd: workspace, glob: ["!src/core/*"] })
            
            // helper.ts is in utils, should show up
            expect(files.length).toBe(1)
            expect(files).toContain(path.normalize("src/utils/helper.ts"))
        })

        it("should respect maxDepth limit", async () => {
            const { provider, workspace } = setup()
            // Using maxDepth 1. src is depth 1. files inside src are depth 2.
            const files = await provider.listFiles({ cwd: workspace, maxDepth: 1 })
            
            // Depth 0: virtual-workspace
            // Depth 1: src, .git, .hidden
            // It should only find files at depth 0 or 1.
            // None of our test real files are at depth 1 except .hidden (if we requested it)
            // But we didn't request hidden: true
            expect(files.length).toBe(0)
        })

        it("should grep for a simple pattern across all files", async () => {
            const { provider, workspace, isNode } = setup()
            const pattern = isNode ? "match-me node" : "match-me in-memory"
            
            const matches = await provider.grep({
                pattern,
                path: workspace
            })

            // Should find in the three main files, .git is excluded
            expect(matches.length).toBe(3)
            
            const matchedFiles = matches.map(m => m.file)
            // For NodeSearchProvider grep -H might output absolute paths, but we passed path: workspace (which is absolute)
            // So output files will start with workspace. Let's make sure they contain the relative ends
            const hasIndexFile = matchedFiles.some(f => f.endsWith("index.ts"))
            const hasHelperFile = matchedFiles.some(f => f.endsWith("helper.ts"))
            const hasTestFile = matchedFiles.some(f => f.endsWith("test.md"))

            expect(hasIndexFile).toBe(true)
            expect(hasHelperFile).toBe(true)
            expect(hasTestFile).toBe(true)
        })

        it("should grep with include pattern", async () => {
            const { provider, workspace, isNode } = setup()
            const pattern = isNode ? "match-me node" : "match-me in-memory"
            
            const matches = await provider.grep({
                pattern,
                path: workspace,
                include: "*.ts"
            })

            // test.md should be filtered out
            expect(matches.length).toBe(2)
            
            const matchedFiles = matches.map(m => m.file)
            expect(matchedFiles.some(f => f.endsWith("index.ts"))).toBe(true)
            expect(matchedFiles.some(f => f.endsWith("helper.ts"))).toBe(true)
            expect(matchedFiles.some(f => f.endsWith("test.md"))).toBe(false)
        })
    }
})
