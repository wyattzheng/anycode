import { testPaths } from "./_test-paths"
/**
 * Test: ConfigMarkdown — YAML frontmatter parsing
 *
 * Verifies:
 *   1. Parsing SKILL.md / AGENTS.md files with valid frontmatter
 *   2. Fallback sanitization for invalid YAML (colons in values)
 *   3. File reference regex (@file patterns)
 *   4. Shell reference regex (!`cmd` patterns)
 *
 * Uses InMemoryFS for all file operations — no real disk I/O.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent } from "../src/index"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import { InMemorySearchProvider } from "./fixtures/search-memory"

describe("ConfigMarkdown", () => {
    let memfs: InMemoryFS
    let agent: CodeAgent
    let paths: ReturnType<typeof testPaths>
    const workDir = "/virtual/config-md-test"

    beforeAll(async () => {
        paths = testPaths()
        memfs = new InMemoryFS()

        agent = new CodeAgent({
            directory: workDir,
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

    describe("parse()", () => {
        it("should parse a file with valid YAML frontmatter", async () => {
            await memfs.write(`${workDir}/valid-skill.md`, [
                "---",
                "name: my-skill",
                "description: A test skill",
                "---",
                "",
                "# Skill Instructions",
                "Do something useful.",
            ].join("\n"))

            const { Instance } = await import("@any-code/opencode/project/instance")
            const result = await Instance.provide(agent.agentContext, async () => {
                const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
                return ConfigMarkdown.parse(agent.agentContext, `${workDir}/valid-skill.md`)
            })

            expect(result).toBeDefined()
            expect(result.data.name).toBe("my-skill")
            expect(result.data.description).toBe("A test skill")
            expect(result.content).toContain("# Skill Instructions")
        })

        it("should parse empty frontmatter", async () => {
            await memfs.write(`${workDir}/empty-fm.md`, [
                "---",
                "---",
                "Just content, no metadata.",
            ].join("\n"))

            const { Instance } = await import("@any-code/opencode/project/instance")
            const result = await Instance.provide(agent.agentContext, async () => {
                const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
                return ConfigMarkdown.parse(agent.agentContext, `${workDir}/empty-fm.md`)
            })

            expect(result).toBeDefined()
            expect(Object.keys(result.data)).toHaveLength(0)
            expect(result.content).toContain("Just content")
        })

        it("should handle frontmatter with colons in values via fallback", async () => {
            await memfs.write(`${workDir}/colon-fm.md`, [
                "---",
                "name: my-skill",
                "description: A skill: does things: many things",
                "---",
                "Content here.",
            ].join("\n"))

            const { Instance } = await import("@any-code/opencode/project/instance")
            const result = await Instance.provide(agent.agentContext, async () => {
                const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
                return ConfigMarkdown.parse(agent.agentContext, `${workDir}/colon-fm.md`)
            })

            expect(result).toBeDefined()
            expect(result.data.name).toBe("my-skill")
            // The description should survive the fallback sanitization
            expect(result.data.description).toContain("A skill")
        })
    })

    describe("fallbackSanitization()", () => {
        it("should convert colon-containing values to block scalars", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")

            const input = [
                "---",
                "name: test",
                "desc: value: with: colons",
                "---",
                "body",
            ].join("\n")

            const sanitized = ConfigMarkdown.fallbackSanitization(input)
            expect(sanitized).toContain("desc: |-")
            expect(sanitized).toContain("  value: with: colons")
        })

        it("should leave already-quoted values alone", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")

            const input = [
                "---",
                'name: "already quoted"',
                "---",
                "body",
            ].join("\n")

            const sanitized = ConfigMarkdown.fallbackSanitization(input)
            expect(sanitized).toContain('"already quoted"')
        })

        it("should not modify content without frontmatter", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")

            const input = "Just plain markdown content."
            const sanitized = ConfigMarkdown.fallbackSanitization(input)
            expect(sanitized).toBe(input)
        })
    })

    describe("files() regex", () => {
        it("should extract @file references", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
            const template = "Read @src/index.ts and @package.json for context."
            const matches = ConfigMarkdown.files(template)

            expect(matches.length).toBe(2)
            expect(matches[0][1]).toBe("src/index.ts")
            expect(matches[1][1]).toBe("package.json")
        })

        it("should extract dotfile references", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
            const template = "Check @.eslintrc.json for config."
            const matches = ConfigMarkdown.files(template)

            expect(matches.length).toBe(1)
            expect(matches[0][1]).toBe(".eslintrc.json")
        })

        it("should not match @ inside backticks", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
            const template = "Use `@scope/package` but also @real-file.ts"
            const matches = ConfigMarkdown.files(template)

            const refs = matches.map(m => m[1])
            expect(refs).toContain("real-file.ts")
        })
    })

    describe("shell() regex", () => {
        it("should extract shell command references", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
            const template = "Run !`npm test` and !`git status` for info."
            const matches = ConfigMarkdown.shell(template)

            expect(matches.length).toBe(2)
            expect(matches[0][1]).toBe("npm test")
            expect(matches[1][1]).toBe("git status")
        })

        it("should return empty for no shell commands", async () => {
            const { ConfigMarkdown } = await import("@any-code/opencode/config/markdown")
            const template = "No commands here."
            const matches = ConfigMarkdown.shell(template)
            expect(matches.length).toBe(0)
        })
    })
})
