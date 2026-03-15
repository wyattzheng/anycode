import { testPaths } from "./_test-paths"
/**
 * Test: Skill module — skill discovery and loading
 *
 * Verifies:
 *   1. Auto-loading skills from .opencode/skills/ directory
 *   2. Auto-loading from .agents/skills/ (external agent-compatible)
 *   3. Nested skill directories
 *   4. Skill.get() / Skill.all() / Skill.available() / Skill.dirs()
 *   5. Malformed SKILL.md files silently ignored
 *   6. Skill.fmt() produces correct formatted output
 *
 * Uses InMemoryFS + InMemorySearchProvider — no real disk I/O.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { CodeAgent } from "../src/index"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import { InMemorySearchProvider } from "./fixtures/search-memory"
import { Skill } from "@any-code/opencode/skill/index"
import { SqlJsStorage } from "../src/storage-sqljs"

describe("Skill: auto-loading from designated directories", () => {
    let agent: CodeAgent
    let memfs: InMemoryFS
    let paths: ReturnType<typeof testPaths>
    const workDir = "/virtual/skill-test"

    beforeAll(async () => {
        paths = testPaths()
        memfs = new InMemoryFS()

        // ── .opencode/skills/ — primary skill directory ──
        await memfs.write(`${workDir}/.opencode/skills/greet/SKILL.md`, [
            "---",
            "name: greet",
            "description: Greets the user",
            "---",
            "",
            "# Greet Skill",
            "Say hello to the user.",
        ].join("\n"))

        await memfs.write(`${workDir}/.opencode/skills/deploy/SKILL.md`, [
            "---",
            "name: deploy",
            "description: Deploy the application",
            "---",
            "",
            "# Deploy Skill",
            "Run the deploy pipeline.",
        ].join("\n"))

        // Broken skill — no name field, should be silently ignored
        await memfs.write(`${workDir}/.opencode/skills/broken/SKILL.md`, [
            "---",
            "title: not-a-name",
            "---",
            "This skill has no name field.",
        ].join("\n"))

        // ── .agents/skills/ — external agent-compatible directory ──
        await memfs.write(`${workDir}/.agents/skills/lint/SKILL.md`, [
            "---",
            "name: lint",
            "description: Run linting checks",
            "---",
            "",
            "# Lint Skill",
            "Run eslint on the project.",
        ].join("\n"))

        // ── Nested skill directory ──
        await memfs.write(`${workDir}/.opencode/skills/tools/formatter/SKILL.md`, [
            "---",
            "name: formatter",
            "description: Format code",
            "---",
            "",
            "# Formatter Skill",
            "Run prettier on source files.",
        ].join("\n"))

        agent = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: workDir,
            worktree: workDir,
            skipPlugins: true,
            fs: memfs,
            search: new InMemorySearchProvider(memfs),
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

    it("should auto-discover skills from .opencode/skills/ and load them", async () => {
        const skills = await agent.agentContext.skill.all()
        const names = skills.map((s: any) => s.name).sort()
        expect(names).toContain("greet")
        expect(names).toContain("deploy")
    })

    it("should load the full skill content and resolve the SKILL.md location", async () => {
        const skill = await agent.agentContext.skill.get("greet")

        expect(skill).toBeDefined()
        expect(skill!.name).toBe("greet")
        expect(skill!.description).toBe("Greets the user")
        expect(skill!.content).toContain("# Greet Skill")
        expect(skill!.content).toContain("Say hello to the user.")
        expect(skill!.location).toContain("SKILL.md")
    })

    it("should auto-discover skills from .agents/skills/ (external agent-compatible)", async () => {
        const skill = await agent.agentContext.skill.get("lint")

        expect(skill).toBeDefined()
        expect(skill!.name).toBe("lint")
        expect(skill!.description).toBe("Run linting checks")
        expect(skill!.content).toContain("# Lint Skill")
    })

    it("should auto-discover nested skill directories", async () => {
        const skill = await agent.agentContext.skill.get("formatter")

        expect(skill).toBeDefined()
        expect(skill!.name).toBe("formatter")
        expect(skill!.description).toBe("Format code")
        expect(skill!.content).toContain("# Formatter Skill")
    })

    it("should make auto-loaded skills visible via available()", async () => {
        const availableSkills = await agent.agentContext.skill.available()

        const names = availableSkills.map((s: any) => s.name)
        expect(names).toContain("greet")
        expect(names).toContain("deploy")
    })

    it("should return undefined for non-existent skill name", async () => {
        const skill = await agent.agentContext.skill.get("nonexistent")
        expect(skill).toBeUndefined()
    })

    it("should silently ignore malformed SKILL.md (no name field)", async () => {
        const skills = await agent.agentContext.skill.all()

        const names = skills.map((s: any) => s.name)
        expect(names).not.toContain("broken")
        expect(names).not.toContain("not-a-name")
    })

    it("should track skill directories for all loaded skills", async () => {
        const dirs = await agent.agentContext.skill.dirs()
        expect(dirs.length).toBeGreaterThanOrEqual(2)
    })
})

describe("Skill.fmt()", () => {
    it("should format skills in verbose mode", async () => {
        const skills: Skill.Info[] = [
            { name: "test-skill", description: "A test", location: "/tmp/test/SKILL.md", content: "body" },
        ]

        const output = Skill.fmt(skills, { verbose: true })
        expect(output).toContain("<available_skills>")
        expect(output).toContain("<name>test-skill</name>")
        expect(output).toContain("<description>A test</description>")
    })

    it("should format skills in non-verbose mode", async () => {
        const skills: Skill.Info[] = [
            { name: "test-skill", description: "A test", location: "/tmp/test/SKILL.md", content: "body" },
        ]

        const output = Skill.fmt(skills, { verbose: false })
        expect(output).toContain("## Available Skills")
        expect(output).toContain("**test-skill**")
        expect(output).toContain("A test")
    })

    it("should return 'No skills' message for empty list", async () => {
        const output = Skill.fmt([], { verbose: false })
        expect(output).toContain("No skills")
    })
})
