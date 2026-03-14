/**
 * Test: Text streaming flow
 *
 * Verifies that CodeAgent correctly streams text delta events
 * when the LLM returns a simple text response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"

describe("CodeAgent text streaming", () => {
    let agent: CodeAgent
    let tmpDir: string

    beforeAll(async () => {
        tmpDir = createTempDir()

        agent = new CodeAgent({
            directory: tmpDir,
            skipPlugins: true,
            fs: new NodeFS(),
            provider: {
                // Use openai provider so ai-sdk makes calls to /v1/chat/completions
                // MSW will intercept these
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1", // MSW will intercept
            },
        })

        await agent.init()
    }, 60_000)

    afterAll(() => {
        cleanupTempDir(tmpDir)
    })

    it("should initialize without errors", () => {
        expect(agent).toBeDefined()
        expect(agent.config.directory).toBe(tmpDir)
    })

    it("should create a session", async () => {
        const session = await agent.createSession("test session")
        expect(session).toBeDefined()
        expect(session.id).toBeTruthy()
        expect(session.title).toBe("test session")
    })

    it("should stream text delta events", async () => {
        const session = await agent.createSession()
        const events: Array<{ type: string; content?: string }> = []

        for await (const event of agent.chat(session.id, "Say Hello World")) {
            events.push(event)
        }

        // Should have at least one text_delta event
        const textEvents = events.filter((e) => e.type === "text_delta")
        expect(textEvents.length).toBeGreaterThan(0)

        // Should end with a done event
        const lastEvent = events[events.length - 1]
        expect(lastEvent.type).toBe("done")
    })

    it("should collect text deltas into full response", async () => {
        const session = await agent.createSession()
        let fullText = ""

        for await (const event of agent.chat(session.id, "Say Hello World")) {
            if (event.type === "text_delta" && event.content) {
                fullText += event.content
            }
        }

        // MSW returns "Hello! How can I help you?" in the text stream fixture
        expect(fullText).toContain("Hello")
        expect(fullText).toContain("help you")
    })
})
