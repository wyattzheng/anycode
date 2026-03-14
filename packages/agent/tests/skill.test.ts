import { testPaths } from "./_test-paths"
/**
 * Test: Skill module — skill discovery and loading from filesystem
 *
 * Verifies:
 *   1. Loading skills from .opencode/skills/ directory
 *   2. Skill.get() returns specific skill by name
 *   3. Skill.all() returns all loaded skills
 *   4. Malformed SKILL.md files are ignored gracefully
 *   5. Skill.fmt() produces correct formatted output
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import path from "path"
import fs from "fs"

describe("Skill: filesystem loading", () => {
    let tmpDir: string
    let agent: CodeAgent
    let paths: ReturnType<typeof testPaths>

    beforeAll(async () => {
        tmpDir = createTempDir("skill-test-")
        paths = testPaths()

        // Create .opencode/skills/ structure with SKILL.md files
        const skillDir1 = path.join(tmpDir, ".opencode", "skills", "greet")
        const skillDir2 = path.join(tmpDir, ".opencode", "skills", "deploy")
        const skillDirBad = path.join(tmpDir, ".opencode", "skills", "broken")

        fs.mkdirSync(skillDir1, { recursive: true })
        fs.mkdirSync(skillDir2, { recursive: true })
        fs.mkdirSync(skillDirBad, { recursive: true })

        // Valid skill 1
        fs.writeFileSync(path.join(skillDir1, "SKILL.md"), [
            "---",
            "name: greet",
            "description: Greets the user",
            "---",
            "",
            "# Greet Skill",
            "Say hello to the user.",
        ].join("\n"))

        // Valid skill 2
        fs.writeFileSync(path.join(skillDir2, "SKILL.md"), [
            "---",
            "name: deploy",
            "description: Deploy the application",
            "---",
            "",
            "# Deploy Skill",
            "Run the deploy pipeline.",
        ].join("\n"))

        // Broken skill — no name field
        fs.writeFileSync(path.join(skillDirBad, "SKILL.md"), [
            "---",
            "title: not-a-name",
            "---",
            "This skill has no name field.",
        ].join("\n"))

        agent = new CodeAgent({
            directory: tmpDir,
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

    it("should load all valid skills from .opencode/skills/", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const skills = await Instance.provide(agent.agentContext, async () => {
            const { Skill } = await import("@any-code/opencode/skill/skill")
            return Skill.all(agent.agentContext)
        })

        expect(skills.length).toBe(2)
        const names = skills.map((s: any) => s.name).sort()
        expect(names).toEqual(["deploy", "greet"])
    })

    it("should return a specific skill by name via get()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const skill = await Instance.provide(agent.agentContext, async () => {
            const { Skill } = await import("@any-code/opencode/skill/skill")
            return Skill.get(agent.agentContext, "greet")
        })

        expect(skill).toBeDefined()
        expect(skill!.name).toBe("greet")
        expect(skill!.description).toBe("Greets the user")
        expect(skill!.content).toContain("# Greet Skill")
        expect(skill!.location).toContain("SKILL.md")
    })

    it("should return undefined for non-existent skill name", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const skill = await Instance.provide(agent.agentContext, async () => {
            const { Skill } = await import("@any-code/opencode/skill/skill")
            return Skill.get(agent.agentContext, "nonexistent")
        })

        expect(skill).toBeUndefined()
    })

    it("should ignore malformed SKILL.md without crashing", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const skills = await Instance.provide(agent.agentContext, async () => {
            const { Skill } = await import("@any-code/opencode/skill/skill")
            return Skill.all(agent.agentContext)
        })

        // "broken" skill has no name, should be ignored
        const names = skills.map((s: any) => s.name)
        expect(names).not.toContain("broken")
        expect(names).not.toContain("not-a-name")
    })

    it("should return skill directories via dirs()", async () => {
        const { Instance } = await import("@any-code/opencode/project/instance")
        const dirs = await Instance.provide(agent.agentContext, async () => {
            const { Skill } = await import("@any-code/opencode/skill/skill")
            return Skill.dirs(agent.agentContext)
        })

        expect(dirs.length).toBeGreaterThanOrEqual(2)
    })
})

describe("Skill.fmt()", () => {
    it("should format skills in verbose mode", async () => {
        const { Skill } = await import("@any-code/opencode/skill/skill")

        const skills: import("@any-code/opencode/skill/skill").Skill.Info[] = [
            { name: "test-skill", description: "A test", location: "/tmp/test/SKILL.md", content: "body" },
        ]

        const output = Skill.fmt(skills, { verbose: true })
        expect(output).toContain("<available_skills>")
        expect(output).toContain("<name>test-skill</name>")
        expect(output).toContain("<description>A test</description>")
    })

    it("should format skills in non-verbose mode", async () => {
        const { Skill } = await import("@any-code/opencode/skill/skill")

        const skills: import("@any-code/opencode/skill/skill").Skill.Info[] = [
            { name: "test-skill", description: "A test", location: "/tmp/test/SKILL.md", content: "body" },
        ]

        const output = Skill.fmt(skills, { verbose: false })
        expect(output).toContain("## Available Skills")
        expect(output).toContain("**test-skill**")
        expect(output).toContain("A test")
    })

    it("should return 'No skills' message for empty list", async () => {
        const { Skill } = await import("@any-code/opencode/skill/skill")
        const output = Skill.fmt([], { verbose: false })
        expect(output).toContain("No skills")
    })
})
