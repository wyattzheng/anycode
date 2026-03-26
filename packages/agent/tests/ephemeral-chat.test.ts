import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Ephemeral chat mode
 *
 * Verifies that:
 *   1. snapshotMessages / rollbackMessages only removes new messages
 *   2. Pre-existing messages survive rollback
 *   3. Without ephemeral, messages accumulate normally
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "../src/storage-sqljs"
import { MessageV2 } from "../src/memory/message-v2"
import { MessageID, PartID } from "../src/session/schema"

describe("Ephemeral chat: snapshotMessages / rollbackMessages", () => {
    let agent: CodeAgent
    let tmpDir: string
    let sessionId: any

    beforeAll(async () => {
        tmpDir = createTempDir()
        agent = new CodeAgent({
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
        await agent.init()
        const session = await agent.agentContext.session.create()
        sessionId = session.id
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    function memory() { return agent.agentContext.memory }

    async function addMessage(text: string) {
        const msgId = MessageID.ascending()
        await memory().updateMessage({
            id: msgId,
            sessionID: sessionId,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4o" },
        })
        await memory().updatePart({
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: msgId,
            type: "text" as const,
            text,
        })
        return msgId
    }

    async function getMessageCount() {
        const msgs: MessageV2.WithParts[] = []
        for await (const msg of MessageV2.stream(agent.agentContext, sessionId)) {
            msgs.push(msg)
        }
        return msgs.length
    }

    it("rollback should remove only messages created after the snapshot", async () => {
        // Pre-existing message
        const preExistingId = await addMessage("I existed before the snapshot")
        const countBefore = await getMessageCount()

        // Take snapshot
        const snapshot = memory().snapshotMessages(sessionId)
        expect(snapshot).toContain(preExistingId)

        // Simulate ephemeral chat: add new messages
        await addMessage("ephemeral message 1")
        await addMessage("ephemeral message 2")
        expect(await getMessageCount()).toBe(countBefore + 2)

        // Rollback
        await memory().rollbackMessages(sessionId, snapshot)

        // Only the pre-existing message should remain
        expect(await getMessageCount()).toBe(countBefore)
        const remaining = memory().snapshotMessages(sessionId)
        expect(remaining).toContain(preExistingId)
    })

    it("without rollback, messages should accumulate as normal", async () => {
        const countBefore = await getMessageCount()

        await addMessage("normal message 1")
        await addMessage("normal message 2")

        // No snapshot/rollback — messages persist
        expect(await getMessageCount()).toBe(countBefore + 2)
    })

    it("rollback with empty snapshot should remove all messages", async () => {
        // Add some messages
        await addMessage("will be removed 1")
        await addMessage("will be removed 2")
        expect(await getMessageCount()).toBeGreaterThan(0)

        // Rollback with empty snapshot (nothing to keep)
        await memory().rollbackMessages(sessionId, [])
        expect(await getMessageCount()).toBe(0)
    })

    it("rollback should be a no-op when no new messages were added", async () => {
        await addMessage("stable message")
        const snapshot = memory().snapshotMessages(sessionId)
        const countBefore = await getMessageCount()

        // No new messages added between snapshot and rollback
        await memory().rollbackMessages(sessionId, snapshot)

        expect(await getMessageCount()).toBe(countBefore)
    })
})
