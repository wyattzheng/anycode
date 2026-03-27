import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Session persistence
 *
 * Verifies that:
 *   1. Agent auto-creates a session on first chat
 *   2. Session persists in the database and can be retrieved
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "@any-code/utils"

describe("CodeAgent: session persistence", () => {
    let agent: CodeAgent
    let tmpDir: string
    let dataPath: ReturnType<typeof testPaths>

    beforeAll(async () => {
        tmpDir = createTempDir()
        dataPath = testPaths()
        agent = new CodeAgent({
            ...testNodeDeps(),
            storage: new SqlJsStorage(),
            directory: tmpDir,
            fs: new NodeFS(),
            search: new NodeSearchProvider(),
            dataPath,
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

    it("should auto-create a session on first chat and assign ID", async () => {
        for await (const event of agent.chat("hello")) {
            // consume all events
        }

        expect(agent.sessionId).toBeDefined()
        expect(typeof agent.sessionId).toBe("string")
        expect(agent.sessionId!.length).toBeGreaterThan(0)
    })

    it("should persist session in the database (retrieve via Session module)", async () => {
        const { Session } = await import("../src/index")
        const sessions = [...agent.agentContext.session.list()]
        const found = sessions.find(s => s.id === agent.sessionId)

        expect(found).toBeDefined()
        expect(found!.id).toBe(agent.sessionId)
    })

    it("should list at least one session after chatting", async () => {
        const { Session } = await import("../src/index")
        const sessions = [...agent.agentContext.session.list()]

        expect(sessions.length).toBeGreaterThanOrEqual(1)
    })
})
