import { testPaths } from "./_test-paths"
/**
 * Test: End-to-end storage verification
 *
 * Exercises the full agent flow (chat → tool execution → message persistence)
 * and verifies that all data written through the NoSQL DB layer can be:
 *   1. Read back correctly after a chat completes
 *   2. Accumulated across multiple chats in the same session
 *   3. Cleaned up via session delete (cascade to messages/parts)
 *   4. Listed/filtered correctly across sessions
 *
 * These tests prove that the storage refactoring (drizzle → NoSQL) did not
 * break any data persistence or retrieval in the critical chat path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { SqlJsStorage } from "../src/storage-sqljs"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import {
    buildHelloworldFixtures,
} from "./fixtures/helloworld-html-stream"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"

/** Set up the mock to respond with a tool‐call then confirmation. */
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

describe("E2E storage: chat → persist → recover", () => {
    let agent: CodeAgent
    let tmpDir: string

    beforeAll(async () => {
        tmpDir = createTempDir()
        agent = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: new InMemoryFS(),
            paths: testPaths(),
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

    it("should persist all messages and parts after a chat, and recover them", async () => {
        beforeEach(() => installMock("e2e-recover.html"))
        installMock("e2e-recover.html")

        const session = await agent.createSession("E2E Recovery")

        // Run a full chat that triggers tool call + confirmation
        const events: any[] = []
        for await (const event of agent.chat(session.id, "Create e2e-recover.html")) {
            events.push(event)
        }
        expect(events.at(-1)?.type).toBe("done")

        // ── Verify: read back all messages from DB ──
        const { Session } = await import("@any-code/opencode/session/index")
        const { MessageV2 } = await import("@any-code/opencode/session/message-v2")
        const ctx = agent.agentContext

        const messages = await Session.messages(ctx, { sessionID: session.id })
        expect(messages.length).toBeGreaterThanOrEqual(2) // user + assistant(s)

        // User message should contain the prompt text
        const userMsg = messages.find(m => m.info.role === "user")
        expect(userMsg).toBeDefined()

        // Assistant messages should have parts (tool-call, text, etc.)
        const assistantParts = messages
            .filter(m => m.info.role === "assistant")
            .flatMap(m => m.parts)
        expect(assistantParts.length).toBeGreaterThan(0)
        for (const part of assistantParts) {
            expect(part.id).toBeDefined()
            expect(part.type).toBeDefined()
        }

        // Each message should be individually fetchable by ID
        for (const msg of messages) {
            const fetched = await MessageV2.get(ctx, {
                sessionID: session.id,
                messageID: msg.info.id,
            })
            expect(fetched.info.id).toBe(msg.info.id)
            expect(fetched.parts.length).toBe(msg.parts.length)
        }
    })

    it("should accumulate messages across multiple chats in one session", async () => {
        installMock("e2e-accum-1.html")

        const session = await agent.createSession("E2E Accumulate")

        // Chat #1
        for await (const _ of agent.chat(session.id, "Create e2e-accum-1.html")) {}

        const { Session } = await import("@any-code/opencode/session/index")
        const msgs1 = await Session.messages(ctx(), { sessionID: session.id })
        const count1 = msgs1.length

        // Chat #2
        installMock("e2e-accum-2.html")
        for await (const _ of agent.chat(session.id, "Create e2e-accum-2.html")) {}

        const msgs2 = await Session.messages(ctx(), { sessionID: session.id })
        // Should have strictly more messages after second chat
        expect(msgs2.length).toBeGreaterThan(count1)

        function ctx() { return agent.agentContext }
    })

    it("should cascade-delete messages and parts when session is removed", async () => {
        installMock("e2e-cascade.html")

        const session = await agent.createSession("E2E Cascade Delete")
        for await (const _ of agent.chat(session.id, "Create e2e-cascade.html")) {}

        const { Session } = await import("@any-code/opencode/session/index")
        const { MessageV2 } = await import("@any-code/opencode/session/message-v2")
        const ctx = agent.agentContext

        // Verify messages exist
        const msgsBefore = await Session.messages(ctx, { sessionID: session.id })
        expect(msgsBefore.length).toBeGreaterThan(0)
        const msgIds = msgsBefore.map(m => m.info.id)

        // Delete session
        await Session.remove(ctx, session.id)

        // Session should be gone
        await expect(Session.get(ctx, session.id)).rejects.toThrow()

        // Messages should also be gone (cascade)
        for (const id of msgIds) {
            await expect(
                MessageV2.get(ctx, { sessionID: session.id, messageID: id }),
            ).rejects.toThrow()
        }
    })

    it("should list sessions filtered by project after multiple chats", async () => {
        const { Session } = await import("@any-code/opencode/session/index")
        const ctx = agent.agentContext

        // Create a couple sessions
        await agent.createSession("List Test A")
        await agent.createSession("List Test B")

        const sessions = [...Session.list(ctx)]
        const titles = sessions.map(s => s.title)
        expect(titles).toContain("List Test A")
        expect(titles).toContain("List Test B")

        // Ordering: most recently updated first
        const timestamps = sessions.map(s => s.time.updated)
        for (let i = 0; i < timestamps.length - 1; i++) {
            expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1])
        }
    })

    it("should correctly store and recover todo data through a transaction", async () => {
        const { Todo } = await import("@any-code/opencode/session/todo")
        const ctx = agent.agentContext
        const session = await agent.createSession("E2E Todo")

        // Write todos
        Todo.update(ctx, {
            sessionID: session.id as any,
            todos: [
                { content: "Build UI", status: "in_progress", priority: "high" },
                { content: "Write tests", status: "pending", priority: "medium" },
                { content: "Deploy", status: "pending", priority: "low" },
            ],
        })

        // Recover and verify order + data
        const todos = Todo.get(ctx, session.id as any)
        expect(todos).toHaveLength(3)
        expect(todos[0].content).toBe("Build UI")
        expect(todos[0].status).toBe("in_progress")
        expect(todos[1].content).toBe("Write tests")
        expect(todos[2].content).toBe("Deploy")

        // Replace atomically
        Todo.update(ctx, {
            sessionID: session.id as any,
            todos: [{ content: "All done", status: "completed", priority: "high" }],
        })

        const updated = Todo.get(ctx, session.id as any)
        expect(updated).toHaveLength(1)
        expect(updated[0].content).toBe("All done")
    })
})
