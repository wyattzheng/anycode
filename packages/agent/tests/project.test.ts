import { testPaths } from "./_test-paths"
/**
 * Test: Project module — project discovery
 *
 * Verifies:
 *   1. fromDirectory() detects git repos and extracts project info
 *   2. Non-git directories get vcs: undefined (no git)
 *   3. fromRow() maps database rows to Project.Info
 *
 * Uses NodeFS + real git (project detection relies on git).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import path from "path"
import fs from "fs"
import { execSync } from "child_process"
import { Project } from "@any-code/opencode/agent/project/index"
import { SqlJsStorage } from "../src/storage-sqljs"

describe("Project: discovery from directories", () => {
    let tmpDir: string
    let gitDir: string
    let nonGitDir: string
    let agent: CodeAgent
    let paths: ReturnType<typeof testPaths>

    beforeAll(async () => {
        tmpDir = createTempDir("project-test-")
        paths = testPaths()

        // Create a git-initialized directory
        gitDir = path.join(tmpDir, "git-project")
        fs.mkdirSync(gitDir, { recursive: true })
        execSync("git init --quiet", { cwd: gitDir })
        execSync("git config user.email 'test@test.com'", { cwd: gitDir })
        execSync("git config user.name 'Test'", { cwd: gitDir })
        fs.writeFileSync(path.join(gitDir, "index.ts"), "export default {}")
        execSync("git add . && git commit -m 'init' --quiet", { cwd: gitDir })

        // Non-git directory
        nonGitDir = path.join(tmpDir, "plain-project")
        fs.mkdirSync(nonGitDir, { recursive: true })
        fs.writeFileSync(path.join(nonGitDir, "readme.md"), "# Plain")

        agent = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: new NodeFS(),
            search: new NodeSearchProvider(),
            paths,
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
        })
        await agent.init()
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    it("should detect a git project via fromDirectory()", async () => {
        const result = await Project.fromDirectory(agent.agentContext, gitDir)

        expect(result).toBeDefined()
        expect(result.project.vcs).toBe("git")
        expect(result.project.worktree).toBe(gitDir)
        expect(result.project.id).toBeDefined()
    })

    it("should handle a non-git directory (no vcs)", async () => {
        const result = await Project.fromDirectory(agent.agentContext, nonGitDir)
        // Non-git directories won't have vcs: "git"
        expect(result.project.vcs).toBeUndefined()
    })

    it("should map DB rows to Project.Info via fromRow()", () => {
        const row = {
            id: "test-id" as any,
            worktree: "/test/path",
            vcs: "git",
            name: null,
            icon_url: null,
            icon_color: null,
            time_initialized: null,
            sandboxes: [] as string[],
            commands: null,
            time_created: Date.now(),
            time_updated: Date.now(),
        }

        const info = Project.fromRow(row)
        expect(info.id).toBe("test-id")
        expect(info.worktree).toBe("/test/path")
        expect(info.vcs).toBe("git")
    })
})
