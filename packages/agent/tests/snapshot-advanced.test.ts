import { testPaths } from "./_test-paths"
/**
 * Test: Snapshot module — advanced integration scenarios
 *
 * Extends the basic snapshot tests with:
 *   1. restore() — full state restoration from a snapshot hash
 *   2. Multi-file tracking — changes across multiple files
 *   3. File deletion — detecting and reverting deleted files
 *   4. Subdirectory support — files in nested directories
 *   5. diffFull() deleted file — structured diff for removed files
 *   6. Sequential snapshot/revert — multiple cycles
 *   7. New file revert — reverting newly added files (should delete them)
 *
 * Uses real filesystem + git (Snapshot relies on git operations).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import path from "path"
import fs from "fs"
import { execSync } from "child_process"
import { Snapshot } from "@any-code/opencode/snapshot/index"
import { SqlJsStorage } from "../src/storage-sqljs"

describe("Snapshot: advanced integration", () => {
    let tmpDir: string
    let agent: CodeAgent
    let paths: ReturnType<typeof testPaths>

    beforeAll(async () => {
        tmpDir = createTempDir("snapshot-adv-")
        paths = testPaths()

        // Initialize git repo with an initial commit
        execSync("git init --quiet", { cwd: tmpDir })
        execSync("git config user.email 'test@test.com'", { cwd: tmpDir })
        execSync("git config user.name 'Test'", { cwd: tmpDir })

        // Create initial file structure
        fs.writeFileSync(path.join(tmpDir, "main.ts"), "export const APP = 'main'\n")
        fs.writeFileSync(path.join(tmpDir, "config.json"), '{"version": 1}\n')
        fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, "src", "utils.ts"), "export function add(a: number, b: number) { return a + b }\n")
        fs.writeFileSync(path.join(tmpDir, "src", "helper.ts"), "export const HELPER = true\n")

        execSync("git add .", { cwd: tmpDir })
        execSync("git commit -m 'init' --quiet", { cwd: tmpDir })

        agent = new CodeAgent({
            storage: new SqlJsStorage(),
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
                id: "prj_snapshot_adv" as any,
                worktree: tmpDir,
                vcs: "git",
                time: { created: Date.now(), updated: Date.now() },
                sandboxes: [],
            } as any,
        })
        await agent.init()
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    // ── restore() ──────────────────────────────────────────────────────────

    it("should restore worktree to a previous snapshot state", async () => {
        const hash = await Snapshot.track(agent.agentContext)

        // Modify files
        fs.writeFileSync(path.join(tmpDir, "main.ts"), "export const APP = 'modified'\n")
        fs.writeFileSync(path.join(tmpDir, "config.json"), '{"version": 999}\n')

        // Restore to the snapshot
        await Snapshot.restore(agent.agentContext, hash!)

        // Files should be back to original
        const mainContent = fs.readFileSync(path.join(tmpDir, "main.ts"), "utf-8")
        const configContent = fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8")
        expect(mainContent).toBe("export const APP = 'main'\n")
        expect(configContent).toBe('{"version": 1}\n')
    })

    // ── Multi-file tracking ────────────────────────────────────────────────

    it("should detect changes across multiple files in patch()", async () => {
        const hash = await Snapshot.track(agent.agentContext)

        // Modify multiple files
        fs.writeFileSync(path.join(tmpDir, "main.ts"), "export const APP = 'v2'\n")
        fs.writeFileSync(path.join(tmpDir, "config.json"), '{"version": 2}\n')
        fs.writeFileSync(path.join(tmpDir, "src", "utils.ts"), "export function add(a: number, b: number) { return a + b + 0 }\n")

        const patchResult = await Snapshot.patch(agent.agentContext, hash!)

        expect(patchResult.files.length).toBe(3)

        const basenames = patchResult.files.map(f => path.basename(f))
        expect(basenames).toContain("main.ts")
        expect(basenames).toContain("config.json")
        expect(basenames).toContain("utils.ts")
    })

    it("should revert multiple files at once", async () => {
        const hash = await Snapshot.track(agent.agentContext)

        const originalMain = fs.readFileSync(path.join(tmpDir, "main.ts"), "utf-8")
        const originalConfig = fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8")

        // Modify both
        fs.writeFileSync(path.join(tmpDir, "main.ts"), "COMPLETELY_DIFFERENT\n")
        fs.writeFileSync(path.join(tmpDir, "config.json"), "{}\n")

        const patchResult = await Snapshot.patch(agent.agentContext, hash!)
        await Snapshot.revert(agent.agentContext, [patchResult])

        expect(fs.readFileSync(path.join(tmpDir, "main.ts"), "utf-8")).toBe(originalMain)
        expect(fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8")).toBe(originalConfig)
    })

    // ── File deletion detection ────────────────────────────────────────────

    it("should detect deleted files in patch()", async () => {
        // Create a temporary file
        fs.writeFileSync(path.join(tmpDir, "temp-file.ts"), "export const TEMP = true\n")
        const hash = await Snapshot.track(agent.agentContext)

        // Delete the file
        fs.unlinkSync(path.join(tmpDir, "temp-file.ts"))

        const patchResult = await Snapshot.patch(agent.agentContext, hash!)

        expect(patchResult.files.length).toBeGreaterThanOrEqual(1)
        const basenames = patchResult.files.map(f => path.basename(f))
        expect(basenames).toContain("temp-file.ts")
    })

    it("should revert a deleted file (restore it)", async () => {
        // Ensure file exists
        fs.writeFileSync(path.join(tmpDir, "will-delete.ts"), "export const X = 1\n")
        const hash = await Snapshot.track(agent.agentContext)

        // Delete it
        fs.unlinkSync(path.join(tmpDir, "will-delete.ts"))
        expect(fs.existsSync(path.join(tmpDir, "will-delete.ts"))).toBe(false)

        // Revert should restore it
        const patchResult = await Snapshot.patch(agent.agentContext, hash!)
        await Snapshot.revert(agent.agentContext, [patchResult])

        expect(fs.existsSync(path.join(tmpDir, "will-delete.ts"))).toBe(true)
        expect(fs.readFileSync(path.join(tmpDir, "will-delete.ts"), "utf-8")).toBe("export const X = 1\n")
    })

    // ── New file revert ────────────────────────────────────────────────────

    it("should delete newly added files when reverting to before they existed", async () => {
        // Snapshot BEFORE the new file
        const hash = await Snapshot.track(agent.agentContext)

        // Create a brand new file
        fs.writeFileSync(path.join(tmpDir, "brand-new.ts"), "export const NEW = true\n")

        // Revert — new file should be removed
        const patchResult = await Snapshot.patch(agent.agentContext, hash!)
        expect(patchResult.files.map(f => path.basename(f))).toContain("brand-new.ts")

        await Snapshot.revert(agent.agentContext, [patchResult])

        expect(fs.existsSync(path.join(tmpDir, "brand-new.ts"))).toBe(false)
    })

    // ── Subdirectory operations ────────────────────────────────────────────

    it("should track and diff files in subdirectories", async () => {
        const hash = await Snapshot.track(agent.agentContext)

        // Modify a file in subdirectory
        fs.writeFileSync(path.join(tmpDir, "src", "helper.ts"), "export const HELPER = false // changed\n")

        const diffText = await Snapshot.diff(agent.agentContext, hash!)

        expect(diffText).toContain("helper.ts")
        expect(diffText).toContain("changed")
    })

    it("should handle new files in subdirectories via diffFull()", async () => {
        const hash1 = await Snapshot.track(agent.agentContext)

        // Add file in a new subdirectory
        fs.mkdirSync(path.join(tmpDir, "src", "deep"), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, "src", "deep", "nested.ts"), "export const DEEP = 42\n")

        const hash2 = await Snapshot.track(agent.agentContext)

        const diffs = await Snapshot.diffFull(agent.agentContext, hash1!, hash2!)

        const nestedDiff = diffs.find(d => d.file.includes("nested.ts"))
        expect(nestedDiff).toBeDefined()
        expect(nestedDiff!.status).toBe("added")
        expect(nestedDiff!.additions).toBeGreaterThan(0)
        expect(nestedDiff!.deletions).toBe(0)
        expect(nestedDiff!.after).toContain("DEEP")
        expect(nestedDiff!.before).toBe("")
    })

    // ── diffFull() deleted file ────────────────────────────────────────────

    it("should show deleted files in diffFull() with correct status", async () => {
        // Create a file to delete
        fs.writeFileSync(path.join(tmpDir, "to-remove.ts"), "export const REMOVE_ME = true\n")
        const hash1 = await Snapshot.track(agent.agentContext)

        // Delete the file
        fs.unlinkSync(path.join(tmpDir, "to-remove.ts"))
        const hash2 = await Snapshot.track(agent.agentContext)

        const diffs = await Snapshot.diffFull(agent.agentContext, hash1!, hash2!)

        const removedDiff = diffs.find(d => d.file.includes("to-remove.ts"))
        expect(removedDiff).toBeDefined()
        expect(removedDiff!.status).toBe("deleted")
        expect(removedDiff!.deletions).toBeGreaterThan(0)
        expect(removedDiff!.additions).toBe(0)
        expect(removedDiff!.before).toContain("REMOVE_ME")
        expect(removedDiff!.after).toBe("")
    })

    // ── diffFull() modified file ───────────────────────────────────────────

    it("should show both before and after content for modified files in diffFull()", async () => {
        fs.writeFileSync(path.join(tmpDir, "evolve.ts"), "export const V = 1\n")
        const hash1 = await Snapshot.track(agent.agentContext)

        fs.writeFileSync(path.join(tmpDir, "evolve.ts"), "export const V = 2\n")
        const hash2 = await Snapshot.track(agent.agentContext)

        const diffs = await Snapshot.diffFull(agent.agentContext, hash1!, hash2!)

        const modified = diffs.find(d => d.file.includes("evolve.ts"))
        expect(modified).toBeDefined()
        expect(modified!.status).toBe("modified")
        expect(modified!.before).toContain("V = 1")
        expect(modified!.after).toContain("V = 2")
        expect(modified!.additions).toBeGreaterThanOrEqual(1)
        expect(modified!.deletions).toBeGreaterThanOrEqual(1)
    })

    // ── Sequential snapshot/revert cycles ──────────────────────────────────

    it("should support multiple sequential snapshot→modify→revert cycles", async () => {
        // Cycle 1
        fs.writeFileSync(path.join(tmpDir, "counter.ts"), "export let count = 0\n")
        const snap1 = await Snapshot.track(agent.agentContext)

        fs.writeFileSync(path.join(tmpDir, "counter.ts"), "export let count = 1\n")
        const patch1 = await Snapshot.patch(agent.agentContext, snap1!)
        await Snapshot.revert(agent.agentContext, [patch1])
        expect(fs.readFileSync(path.join(tmpDir, "counter.ts"), "utf-8")).toBe("export let count = 0\n")

        // Cycle 2 — start from the reverted state
        const snap2 = await Snapshot.track(agent.agentContext)

        fs.writeFileSync(path.join(tmpDir, "counter.ts"), "export let count = 100\n")
        const patch2 = await Snapshot.patch(agent.agentContext, snap2!)
        await Snapshot.revert(agent.agentContext, [patch2])
        expect(fs.readFileSync(path.join(tmpDir, "counter.ts"), "utf-8")).toBe("export let count = 0\n")

        // Cycle 3 — modify, snapshot, modify again, revert to last snapshot
        fs.writeFileSync(path.join(tmpDir, "counter.ts"), "export let count = 50\n")
        const snap3 = await Snapshot.track(agent.agentContext)

        fs.writeFileSync(path.join(tmpDir, "counter.ts"), "export let count = 75\n")
        const patch3 = await Snapshot.patch(agent.agentContext, snap3!)
        await Snapshot.revert(agent.agentContext, [patch3])
        expect(fs.readFileSync(path.join(tmpDir, "counter.ts"), "utf-8")).toBe("export let count = 50\n")
    })

    // ── Multiple patches revert ────────────────────────────────────────────

    it("should revert multiple patches in sequence", async () => {
        fs.writeFileSync(path.join(tmpDir, "a.ts"), "A_ORIGINAL\n")
        fs.writeFileSync(path.join(tmpDir, "b.ts"), "B_ORIGINAL\n")
        const snap = await Snapshot.track(agent.agentContext)

        // Modify only a.ts
        fs.writeFileSync(path.join(tmpDir, "a.ts"), "A_CHANGED\n")
        const patch1 = await Snapshot.patch(agent.agentContext, snap!)

        // Now snapshot again and modify b.ts
        const snap2 = await Snapshot.track(agent.agentContext)
        fs.writeFileSync(path.join(tmpDir, "b.ts"), "B_CHANGED\n")
        const patch2 = await Snapshot.patch(agent.agentContext, snap2!)

        // Revert both patches — should restore both files
        await Snapshot.revert(agent.agentContext, [patch1, patch2])

        // a.ts should be reverted to snap (A_ORIGINAL)
        expect(fs.readFileSync(path.join(tmpDir, "a.ts"), "utf-8")).toBe("A_ORIGINAL\n")
        // b.ts reverted to snap2 (but snap2 includes A_CHANGED because a.ts was modified before snap2)
        // Actually: patch2 reverts b.ts to snap2 state, while patch1 reverts a.ts to snap state
        // revert processes patches in order, and deduplicates files
        // Since a.ts appears in patch1, it gets reverted to snap (A_ORIGINAL)
        // b.ts appears in patch2, gets reverted to snap2 (B_ORIGINAL)
        expect(fs.readFileSync(path.join(tmpDir, "b.ts"), "utf-8")).toBe("B_ORIGINAL\n")
    })

    // ── Track returns consistent hash for unchanged state ──────────────────

    it("should return the same hash when nothing has changed", async () => {
        const hash1 = await Snapshot.track(agent.agentContext)
        const hash2 = await Snapshot.track(agent.agentContext)

        expect(hash1).toBe(hash2)
    })

    // ── Track returns different hash after changes ─────────────────────────

    it("should return a different hash after file changes", async () => {
        const hash1 = await Snapshot.track(agent.agentContext)

        fs.writeFileSync(path.join(tmpDir, "change-hash.ts"), "export const H = Math.random()\n")

        const hash2 = await Snapshot.track(agent.agentContext)

        expect(hash1).not.toBe(hash2)
    })
})
