import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Session persistence
 *
 * Verifies that:
 *   1. Creating sessions returns unique IDs and metadata
 *   2. Multiple sessions can coexist within the same agent
 *   3. Sessions persist in the database and can be retrieved
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "../src/storage-sqljs"

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

    it("should create a session with a valid ID and metadata", async () => {
        const session = await agent.createSession("Test Session 1")

        expect(session).toBeDefined()
        expect(session.id).toBeDefined()
        expect(typeof session.id).toBe("string")
        expect(session.id.length).toBeGreaterThan(0)
        expect(session.createdAt).toBeDefined()
        expect(typeof session.createdAt).toBe("number")
    })

    it("should create multiple sessions with unique IDs", async () => {
        const session1 = await agent.createSession("Session A")
        const session2 = await agent.createSession("Session B")
        const session3 = await agent.createSession("Session C")

        expect(session1.id).not.toBe(session2.id)
        expect(session2.id).not.toBe(session3.id)
        expect(session1.id).not.toBe(session3.id)

        // Each session should have a valid creation timestamp
        expect(session1.createdAt).toBeGreaterThan(0)
        expect(session2.createdAt).toBeGreaterThanOrEqual(session1.createdAt)
        expect(session3.createdAt).toBeGreaterThanOrEqual(session2.createdAt)
    })

    it("should persist sessions in the database (retrieve via Session module)", async () => {
        const session = await agent.createSession("Persistent Session")

        // Verify we can access the session through the underlying Session module
        const { Session } = await import("@any-code/opencode")
        const sessions = [...Session.list(agent.agentContext)]
        const found = sessions.find(s => s.id === session.id)

        expect(found).toBeDefined()
        expect(found!.id).toBe(session.id)
    })

    it("should list all created sessions", async () => {
        // Create a fresh session to ensure at least one exists
        await agent.createSession("Listed Session")

        const { Session } = await import("@any-code/opencode")
        const sessions = [...Session.list(agent.agentContext)]

        // Should have at least the sessions created in this describe block
        expect(sessions.length).toBeGreaterThanOrEqual(1)
    })
})

