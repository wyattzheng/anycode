import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Ephemeral chat mode — clearMessages(chatId?) API
 *
 * Verifies:
 *   1. chat() with chatId tags messages in DB
 *   2. clearMessages(chatId) removes only that chat's messages
 *   3. clearMessages() removes all session messages
 *   4. Normal chat messages persist
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "@any-code/utils"
import { MessageV2 } from "../src/memory/message-v2"

function createAgent(tmpDir: string) {
    return new CodeAgent({
        ...testNodeDeps(),
        storage: new SqlJsStorage(),
        directory: tmpDir,
        fs: new NodeFS(),
        search: new NodeSearchProvider(),
        dataPath: testPaths(),
        provider: {
            id: "openai",
            apiKey: "test-key-not-real",
            model: "gpt-4o",
            baseUrl: "http://localhost:19283/v1",
        },
    })
}

describe("clearMessages(chatId?) API", () => {
    let agent: CodeAgent
    let tmpDir: string

    beforeAll(async () => {
        tmpDir = createTempDir()
        agent = createAgent(tmpDir)
        await agent.init()
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    async function getSessionMessageCount() {
        const msgs: MessageV2.WithParts[] = []
        for await (const msg of MessageV2.stream(agent.agentContext, agent.sessionId as any)) {
            msgs.push(msg)
        }
        return msgs.length
    }

    it("normal chat should persist messages", async () => {
        for await (const event of agent.chat("Say Hello World")) { }
        expect(await getSessionMessageCount()).toBeGreaterThan(0)
    })

    it("clearMessages(chatId) should remove only that chat's messages", async () => {
        const chatId = "test-chat-001"
        for await (const event of agent.chat("Ephemeral message", { chatId })) { }
        const countAfterChat = await getSessionMessageCount()
        expect(countAfterChat).toBeGreaterThan(0)

        await agent.clearMessages(chatId)

        const countAfterClear = await getSessionMessageCount()
        // Should be fewer messages (the chatId ones removed)
        expect(countAfterClear).toBeLessThan(countAfterChat)
    })

    it("clearMessages(chatId) should not affect other chats", async () => {
        // Chat A (normal, no explicit chatId)
        for await (const event of agent.chat("Normal message A")) { }
        const countAfterA = await getSessionMessageCount()

        // Chat B (with explicit chatId)
        const chatIdB = "test-chat-B"
        for await (const event of agent.chat("Tagged message B", { chatId: chatIdB })) { }
        const countAfterB = await getSessionMessageCount()
        expect(countAfterB).toBeGreaterThan(countAfterA)

        // Clear only B
        await agent.clearMessages(chatIdB)
        const countAfterClearB = await getSessionMessageCount()
        expect(countAfterClearB).toBe(countAfterA)
    })

    it("clearMessages() should remove ALL session messages", async () => {
        expect(await getSessionMessageCount()).toBeGreaterThan(0)
        await agent.clearMessages()
        expect(await getSessionMessageCount()).toBe(0)
    })

    it("chat() events still stream normally with chatId", async () => {
        const events: Array<{ type: string; content?: string }> = []
        for await (const event of agent.chat("Tell me a joke", { chatId: "stream-test" })) {
            events.push(event)
        }
        const textEvents = events.filter(e => e.type === "text.delta")
        expect(textEvents.length).toBeGreaterThan(0)
        expect(events[events.length - 1].type).toBe("done")
    })
})
