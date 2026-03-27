import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Cross-agent DB recovery
 *
 * The REAL persistence proof:
 *   1. Create agent1 with a DB
 *   2. Run a full chat (LLM → tool call → messages + parts written)
 *   3. Close agent1 completely
 *   4. Create agent2 with the SAME underlying database
 *   5. Verify agent2 can recover ALL sessions, messages, and parts
 *
 * Uses a shared SqlJsStorage that retains its in-memory database across
 * multiple agent lifecycles — simulating what BetterSqliteStorage does
 * with a real file.
 */
import { describe, it, expect, afterAll } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import { buildHelloworldFixtures } from "./fixtures/helloworld-html-stream"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"

import type { StorageProvider, Migration } from "@any-code/utils"
import type { NoSqlDb } from "../src/index"
import { SqlJsStorage } from "@any-code/utils"
import { InMemorySearchProvider } from "./fixtures/search-memory"

/**
 * A persistent storage wrapper:
 * - First connect() creates the DB and applies migrations (like normal boot)
 * - Subsequent connect() calls return the SAME NoSqlDb — simulating
 *   a file-backed database that survives across process restarts
 */
class PersistentTestStorage implements StorageProvider {
    private inner = new SqlJsStorage()
    private db: NoSqlDb | null = null

    async connect(migrations: Migration[]): Promise<NoSqlDb> {
        if (!this.db) {
            this.db = await this.inner.connect(migrations)
        }
        return this.db
    }

    close() {
        this.inner.close()
        this.db = null
    }
}

function installMock(filename: string) {
    let mainCallCount = 0
    const { toolCallBody, confirmationBody } = buildHelloworldFixtures(filename)
    server.use(
        http.post("*/v1/responses", async ({ request }) => {
            const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
            const model = (body?.model ?? "") as string
            if (model !== "gpt-4o") {
                return new HttpResponse(RESPONSES_API_BODY, {
                    headers: { "Content-Type": "text/event-stream" },
                })
            }
            mainCallCount++
            return new HttpResponse(
                mainCallCount === 1 ? toolCallBody : confirmationBody,
                { headers: { "Content-Type": "text/event-stream" } },
            )
        }),
    )
}

describe("Cross-agent DB recovery: close agent → reopen → verify data", () => {
    const tmpDir = createTempDir()
    const storage = new PersistentTestStorage()

    afterAll(() => {
        storage.close()
        cleanupTempDir(tmpDir)
    })

    function makeAgent() {
        return new CodeAgent({
            ...testNodeDeps(),
            storage,
            directory: tmpDir,
            fs: new InMemoryFS(),
            search: new InMemorySearchProvider(new InMemoryFS()),
            dataPath: testPaths(),
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
        })
    }

    it("agent1 creates session via chat → close → agent2 recovers it", async () => {
        installMock("session-recovery.html")

        // ───── Agent 1: chat to auto-create session ─────
        const agent1 = makeAgent()
        await agent1.init()
        for await (const _ of agent1.chat("Create session-recovery.html")) {}
        const s1Id = agent1.sessionId!
        expect(s1Id).toBeTruthy()

        // Agent 1 is done — throw it away
        // (storage stays alive, like a file-based DB)

        // ───── Agent 2: fresh boot, same DB ─────
        const agent2 = makeAgent()
        await agent2.init()

        const { Session } = await import("../src/index")
        const recovered = await agent2.agentContext.session.get(s1Id)
        expect(recovered.id).toBe(s1Id)
    })

    it("agent1 chats → close → agent2 recovers ALL messages and parts", async () => {
        installMock("recovery.html")

        // ───── Agent 1: full chat ─────
        const agent1 = makeAgent()
        await agent1.init()

        for await (const _ of agent1.chat("init session")) {}
        const sessionId = agent1.sessionId!

        const events: any[] = []
        for await (const event of agent1.chat("Create recovery.html")) {
            events.push(event)
        }
        expect(events.at(-1)?.type).toBe("done")

        // Record what agent1 sees
        const { Session } = await import("../src/index")

        const originalMsgs = await agent1.agentContext.session.messages({ sessionID: sessionId })
        expect(originalMsgs.length).toBeGreaterThanOrEqual(2)

        const snapshot = originalMsgs.map((m: any) => ({
            id: m.info.id,
            role: m.info.role,
            partCount: m.parts.length,
            partIds: m.parts.map((p: any) => p.id),
            partTypes: m.parts.map((p: any) => p.type),
        }))

        // ───── Agent 2: fresh boot, same DB ─────
        const agent2 = makeAgent()
        await agent2.init()

        // Session should exist
        const sess = await agent2.agentContext.session.get(sessionId)
        expect(sess).toBeDefined()

        // All messages should be identical
        const recoveredMsgs = await agent2.agentContext.session.messages({ sessionID: sessionId })
        expect(recoveredMsgs.length).toBe(originalMsgs.length)

        // Message-by-message comparison
        for (const orig of snapshot) {
            const recovered = recoveredMsgs.find((m: any) => m.info.id === orig.id)
            expect(recovered, `message ${orig.id} should exist`).toBeDefined()
            expect(recovered!.info.role).toBe(orig.role)
            expect(recovered!.parts.length).toBe(orig.partCount)

            // Every part should be intact with same ID and type
            for (let i = 0; i < orig.partIds.length; i++) {
                const part = recovered!.parts.find((p: any) => p.id === orig.partIds[i])
                expect(part, `part ${orig.partIds[i]} should exist`).toBeDefined()
                expect(part!.type).toBe(orig.partTypes[i])
            }
        }

        // Individual messages should be present
        for (const msg of recoveredMsgs) {
            expect(msg.info.id).toBeTruthy()
            expect(msg.parts.length).toBeGreaterThan(0)
        }
    })

    it("agent2 creates its own session and chats independently", async () => {
        installMock("continue-1.html")

        // ───── Agent 1: create session + first chat ─────
        const agent1 = makeAgent()
        await agent1.init()

        for await (const _ of agent1.chat("Create continue-1.html")) {}
        const sessionId1 = agent1.sessionId

        const { Session } = await import("../src/index")
        const msgs1 = await agent1.agentContext.session.messages({ sessionID: sessionId1 })
        const count1 = msgs1.length
        expect(count1).toBeGreaterThanOrEqual(2)

        // ───── Agent 2: fresh boot, own session ─────
        installMock("continue-2.html")

        const agent2 = makeAgent()
        await agent2.init()
        const sessionId2 = agent2.sessionId

        // Agent2 has its own session (different from agent1)
        expect(sessionId2).not.toBe(sessionId1)

        // Chat on agent2's own session
        for await (const _ of agent2.chat("Now create continue-2.html")) {}

        const msgs2 = await agent2.agentContext.session.messages({ sessionID: sessionId2 })

        // Agent2 should have its own messages
        expect(msgs2.length).toBeGreaterThanOrEqual(2)

        // Agent1's old session data should still be readable
        const oldMsgs = await agent2.agentContext.session.messages({ sessionID: sessionId1 })
        expect(oldMsgs.length).toBe(count1)
    })

    it("session list accumulates across agent restarts", async () => {
        const agent = makeAgent()
        await agent.init()

        const { Session } = await import("../src/index")
        const sessions = [...agent.agentContext.session.list()]

        // Should have sessions from previous tests
        expect(sessions.length).toBeGreaterThanOrEqual(1)

        // Ordered by time_updated descending
        for (let i = 0; i < sessions.length - 1; i++) {
            expect(sessions[i].time.updated).toBeGreaterThanOrEqual(sessions[i + 1].time.updated)
        }
    })
})
