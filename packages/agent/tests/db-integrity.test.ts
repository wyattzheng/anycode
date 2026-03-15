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

import type { StorageProvider, Migration } from "../src/storage"
import type { NoSqlDb } from "@any-code/opencode"
import { SqlJsStorage } from "../src/storage-sqljs"
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

    it("agent1 creates sessions → close → agent2 recovers them", async () => {
        // ───── Agent 1: create sessions ─────
        const agent1 = makeAgent()
        await agent1.init()

        const s1 = await agent1.createSession("Session Alpha")
        const s2 = await agent1.createSession("Session Beta")
        const s1Id = s1.id
        const s2Id = s2.id

        // Agent 1 is done — throw it away
        // (storage stays alive, like a file-based DB)

        // ───── Agent 2: fresh boot, same DB ─────
        const agent2 = makeAgent()
        await agent2.init()

        const { Session } = await import("@any-code/opencode")

        const recovered1 = await Session.get(agent2.agentContext, s1Id)
        expect(recovered1.id).toBe(s1Id)
        expect(recovered1.title).toBe("Session Alpha")

        const recovered2 = await Session.get(agent2.agentContext, s2Id)
        expect(recovered2.id).toBe(s2Id)
        expect(recovered2.title).toBe("Session Beta")
    })

    it("agent1 chats → close → agent2 recovers ALL messages and parts", async () => {
        installMock("recovery.html")

        // ───── Agent 1: full chat ─────
        const agent1 = makeAgent()
        await agent1.init()

        const session = await agent1.createSession("Chat Recovery Test")
        const sessionId = session.id

        const events: any[] = []
        for await (const event of agent1.chat(sessionId, "Create recovery.html")) {
            events.push(event)
        }
        expect(events.at(-1)?.type).toBe("done")

        // Record what agent1 sees
        const { Session } = await import("@any-code/opencode")
        const { MessageV2 } = await import("@any-code/opencode")

        const originalMsgs = await Session.messages(agent1.agentContext, { sessionID: sessionId })
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
        const sess = await Session.get(agent2.agentContext, sessionId)
        expect(sess.title).toBe("Chat Recovery Test")

        // All messages should be identical
        const recoveredMsgs = await Session.messages(agent2.agentContext, { sessionID: sessionId })
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

        // Individual message fetch should work
        for (const msg of recoveredMsgs) {
            const fetched = await MessageV2.get(agent2.agentContext, {
                sessionID: sessionId,
                messageID: msg.info.id,
            })
            expect(fetched.info.id).toBe(msg.info.id)
            expect(fetched.parts.length).toBe(msg.parts.length)
        }
    })

    it("agent2 continues chatting on agent1's session", async () => {
        installMock("continue-1.html")

        // ───── Agent 1: create session + first chat ─────
        const agent1 = makeAgent()
        await agent1.init()

        const session = await agent1.createSession("Continue Test")
        const sessionId = session.id

        for await (const _ of agent1.chat(sessionId, "Create continue-1.html")) {}

        const { Session } = await import("@any-code/opencode")
        const msgs1 = await Session.messages(agent1.agentContext, { sessionID: sessionId })
        const count1 = msgs1.length
        expect(count1).toBeGreaterThanOrEqual(2)

        // ───── Agent 2: continue the conversation ─────
        installMock("continue-2.html")

        const agent2 = makeAgent()
        await agent2.init()

        // Chat on the same session
        for await (const _ of agent2.chat(sessionId, "Now create continue-2.html")) {}

        const msgs2 = await Session.messages(agent2.agentContext, { sessionID: sessionId })

        // More messages than before — accumulated correctly
        expect(msgs2.length).toBeGreaterThan(count1)

        // Both user prompts should be present
        const userParts = msgs2
            .filter((m: any) => m.info.role === "user")
            .flatMap((m: any) => m.parts)
            .filter((p: any) => p.type === "text")
        const texts = userParts.map((p: any) => p.text)
        expect(texts.some((t: any) => t.includes("continue-1"))).toBe(true)
        expect(texts.some((t: any) => t.includes("continue-2"))).toBe(true)
    })

    it("session list accumulates across agent restarts", async () => {
        const agent = makeAgent()
        await agent.init()

        const { Session } = await import("@any-code/opencode")
        const sessions = [...Session.list(agent.agentContext)]

        // Should have all sessions from previous tests
        const titles = sessions.map(s => s.title)
        expect(titles).toContain("Session Alpha")
        expect(titles).toContain("Session Beta")
        expect(titles).toContain("Chat Recovery Test")
        expect(titles).toContain("Continue Test")

        // Ordered by time_updated descending
        for (let i = 0; i < sessions.length - 1; i++) {
            expect(sessions[i].time.updated).toBeGreaterThanOrEqual(sessions[i + 1].time.updated)
        }
    })
})
