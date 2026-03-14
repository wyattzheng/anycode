import { testPaths } from "./_test-paths"
/**
 * Test: Snapshot module — git-based file tracking and diffing
 *
 * Verifies:
 *   1. track() creates a snapshot of the worktree and returns a hash
 *   2. patch() detects changed files after modifications
 *   3. diff() returns diff text for changed files
 *   4. diffFull() returns structured FileDiff with additions/deletions
 *   5. revert() restores files to snapshot state
 *
 * Uses real filesystem + git (Snapshot relies on git operations).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import path from "path"
import fs from "fs"
import { execSync } from "child_process"

describe("Snapshot: git-based tracking", () => {
    let tmpDir: string
    let agent: CodeAgent
    let paths: ReturnType<typeof testPaths>

    beforeAll(async () => {
        tmpDir = createTempDir("snapshot-test-")
        paths = testPaths()

        // Initialize git repo with an initial commit
        execSync("git init --quiet", { cwd: tmpDir })
        execSync("git config user.email 'test@test.com'", { cwd: tmpDir })
        execSync("git config user.name 'Test'", { cwd: tmpDir })

        // Create initial files
        fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const VERSION = 1\n")
        fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello World\n")

        execSync("git add .", { cwd: tmpDir })
        execSync("git commit -m 'init' --quiet", { cwd: tmpDir })

        agent = new CodeAgent({
            directory: tmpDir,
            worktree: tmpDir,
            skipPlugins: true,
            fs: new NodeFS(),
            paths,
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
            project: {
                id: "prj_snapshot_test" as any,
                worktree: tmpDir,
                vcs: "git",
                time: { created: Date.now(), updated: Date.now() },
                sandboxes: [],
            } as any,
        })
        await agent.init()
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    it("should track the current worktree and return a hash", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const hash = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        expect(hash).toBeDefined()
        expect(typeof hash).toBe("string")
        expect(hash!.length).toBeGreaterThan(0)
    })

    it("should detect changed files via patch()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // Take initial snapshot
        const hash = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Modify a file
        fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const VERSION = 2\n")

        // Get patch — should detect the change
        const patch = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.patch(agent.agentContext, hash!)
        })

        expect(patch).toBeDefined()
        expect(patch.hash).toBe(hash)
        expect(patch.files.length).toBeGreaterThanOrEqual(1)

        const changedFiles = patch.files.map(f => path.basename(f))
        expect(changedFiles).toContain("index.ts")
    })

    it("should return diff text via diff()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // Take snapshot before change
        const hash = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Modify file
        fs.writeFileSync(path.join(tmpDir, "readme.md"), "# Hello World\n\nUpdated content.\n")

        // Get diff text
        const diffText = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.diff(agent.agentContext, hash!)
        })

        expect(diffText).toBeDefined()
        expect(diffText).toContain("readme.md")
        expect(diffText).toContain("Updated content")
    })

    it("should return structured FileDiff via diffFull()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // Take initial snapshot
        const hash1 = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Add a new file
        fs.writeFileSync(path.join(tmpDir, "new-file.ts"), "export const NEW = true\n")

        // Take second snapshot
        const hash2 = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Get full diff between two snapshots
        const diffs = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.diffFull(agent.agentContext, hash1!, hash2!)
        })

        expect(diffs).toBeDefined()
        expect(diffs.length).toBeGreaterThanOrEqual(1)

        const newFileDiff = diffs.find(d => d.file.includes("new-file.ts"))
        expect(newFileDiff).toBeDefined()
        expect(newFileDiff!.status).toBe("added")
        expect(newFileDiff!.additions).toBeGreaterThan(0)
        expect(newFileDiff!.after).toContain("NEW")
    })

    it("should revert files to snapshot state", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // Take snapshot of current state
        const hash = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Get current content before modification
        const originalContent = fs.readFileSync(path.join(tmpDir, "index.ts"), "utf-8")

        // Modify the file
        fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const VERSION = 999\n")

        // Get the patch (which files changed)
        const patchResult = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.patch(agent.agentContext, hash!)
        })

        // Revert using the snapshot
        await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            await Snapshot.revert(agent.agentContext, [patchResult])
        })

        // File should be restored to original content
        const restoredContent = fs.readFileSync(path.join(tmpDir, "index.ts"), "utf-8")
        expect(restoredContent).toBe(originalContent)
    })

    it("should handle empty patch when no changes detected", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // Take snapshot
        const hash = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.track(agent.agentContext)
        })

        // Don't change anything — patch should have no files
        const patch = await Instance.provide(agent.agentContext, async () => {
            const { Snapshot } = await import("@any-code/opencode/snapshot/index")
            return Snapshot.patch(agent.agentContext, hash!)
        })

        expect(patch.files).toHaveLength(0)
    })
})
