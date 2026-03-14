import { testPaths } from "./_test-paths"
/**
 * Test: Project module — project discovery from directories and DB persistence
 *
 * Verifies:
 *   1. fromDirectory() detects git repositories
 *   2. fromDirectory() handles non-git directories
 *   3. Project.fromRow() maps DB rows correctly
 *   4. Project.list() and Project.get() work after creating projects
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import path from "path"
import fs from "fs"
import { execSync } from "child_process"

describe("Project: discovery and persistence", () => {
    let tmpDir: string
    let gitDir: string
    let plainDir: string
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
        fs.writeFileSync(path.join(gitDir, "README.md"), "# Test Project")
        execSync("git add .", { cwd: gitDir })
        execSync("git commit -m 'init' --quiet", { cwd: gitDir })

        // Create a plain directory (no git)
        plainDir = path.join(tmpDir, "plain-project")
        fs.mkdirSync(plainDir, { recursive: true })
        fs.writeFileSync(path.join(plainDir, "file.txt"), "hello")

        agent = new CodeAgent({
            directory: gitDir,
            skipPlugins: true,
            fs: new NodeFS(),
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

    it("should detect a git project from directory", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const result = await Instance.provide(agent.agentContext, async () => {
            const { Project } = await import("@any-code/opencode/project/project")
            return Project.fromDirectory(agent.agentContext, gitDir)
        })

        expect(result).toBeDefined()
        expect(result.project).toBeDefined()
        expect(result.project.vcs).toBe("git")
        expect(result.project.worktree).toBe(gitDir)
    })

    it("should handle non-git directory gracefully", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const result = await Instance.provide(agent.agentContext, async () => {
            const { Project } = await import("@any-code/opencode/project/project")
            return Project.fromDirectory(agent.agentContext, plainDir)
        })

        expect(result).toBeDefined()
        expect(result.project).toBeDefined()
        // Non-git dir should not have vcs set to "git"
        expect(result.project.vcs).toBeUndefined()
    })

    it("should persist and retrieve projects via list()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")

        // First create the project via fromDirectory (which persists to DB)
        await Instance.provide(agent.agentContext, async () => {
            const { Project } = await import("@any-code/opencode/project/project")
            await Project.fromDirectory(agent.agentContext, gitDir)
        })

        // Then list all projects
        const projects = await Instance.provide(agent.agentContext, async () => {
            const { Project } = await import("@any-code/opencode/project/project")
            return Project.list()
        })

        expect(projects.length).toBeGreaterThanOrEqual(1)
        // Should contain our git project
        const found = projects.find(p => p.worktree === gitDir)
        expect(found).toBeDefined()
    })

    it("should retrieve a specific project by ID", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const result = await Instance.provide(agent.agentContext, async () => {
            const { Project } = await import("@any-code/opencode/project/project")
            const { project } = await Project.fromDirectory(agent.agentContext, gitDir)
            return Project.get(project.id)
        })

        expect(result).toBeDefined()
        expect(result!.vcs).toBe("git")
        expect(result!.worktree).toBe(gitDir)
    })
})

describe("Project.fromRow()", () => {
    it("should correctly map a DB row to Project.Info", async () => {
        const { Project } = await import("@any-code/opencode/project/project")
        const now = Date.now()

        const row = {
            id: "prj_test123",
            worktree: "/tmp/test",
            vcs: "git",
            name: "My Project",
            icon_url: "https://example.com/icon.png",
            icon_color: "#ff0000",
            icon_override: null,
            time_created: now,
            time_updated: now,
            time_initialized: now - 1000,
            sandboxes: ["sandbox1"],
            commands: { start: "npm run dev" },
        }

        const info = Project.fromRow(row as any)
        expect(info.id).toBe("prj_test123")
        expect(info.worktree).toBe("/tmp/test")
        expect(info.vcs).toBe("git")
        expect(info.name).toBe("My Project")
        expect(info.icon?.url).toBe("https://example.com/icon.png")
        expect(info.icon?.color).toBe("#ff0000")
        expect(info.time.created).toBe(now)
        expect(info.time.initialized).toBe(now - 1000)
        expect(info.sandboxes).toEqual(["sandbox1"])
        expect(info.commands?.start).toBe("npm run dev")
    })

    it("should handle row with no icon", async () => {
        const { Project } = await import("@any-code/opencode/project/project")
        const now = Date.now()

        const row = {
            id: "prj_noicon",
            worktree: "/tmp/test",
            vcs: null,
            name: null,
            icon_url: null,
            icon_color: null,
            icon_override: null,
            time_created: now,
            time_updated: now,
            time_initialized: null,
            sandboxes: [],
            commands: null,
        }

        const info = Project.fromRow(row as any)
        expect(info.icon).toBeUndefined()
        expect(info.vcs).toBeUndefined()
        expect(info.name).toBeUndefined()
        expect(info.time.initialized).toBeUndefined()
        expect(info.commands).toBeUndefined()
    })
})
