import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Memory roundtrip
 *
 * Verifies that messages + parts stored via MemoryService
 * can be read back correctly via MessageV2.stream / MessageV2.page.
 * This is a safety net for refactoring memory/index.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider, Session } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "@any-code/utils"
import { MessageV2 } from "../src/memory/message-v2"
import { SessionID, MessageID, PartID } from "../src/session/schema"

describe("Memory roundtrip", () => {
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

        // Create a session for testing
        const session = await agent.agentContext.session.create()
        sessionId = session.id
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    /** Shorthand for the memory service */
    function memory() { return agent.agentContext.memory }

    it("should store and retrieve a user message with text part", async () => {
        const ctx = agent.agentContext
        const msgId = MessageID.ascending()

        // Store user message
        await memory().updateMessage({
            id: msgId,
            sessionID: sessionId,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4o" },
        })

        // Store text part
        const partId = PartID.ascending()
        await memory().updatePart({
            id: partId,
            sessionID: sessionId,
            messageID: msgId,
            type: "text" as const,
            text: "Hello World",
        })

        // Read back via stream
        const messages: MessageV2.WithParts[] = []
        for await (const msg of MessageV2.stream(ctx, sessionId)) {
            messages.push(msg)
        }

        expect(messages.length).toBe(1)
        expect(messages[0].info.id).toBe(msgId)
        expect(messages[0].info.role).toBe("user")
        expect(messages[0].parts.length).toBe(1)
        expect(messages[0].parts[0].type).toBe("text")
        expect((messages[0].parts[0] as any).text).toBe("Hello World")
    })

    it("should store and retrieve an assistant message with multiple part types", async () => {
        const ctx = agent.agentContext
        const userMsgId = MessageID.ascending()
        const assistantMsgId = MessageID.ascending()
        const now = Date.now()

        // Store user message first (parent)
        await memory().updateMessage({
            id: userMsgId,
            sessionID: sessionId,
            role: "user" as const,
            time: { created: now },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4o" },
        })

        await memory().updatePart({
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: userMsgId,
            type: "text" as const,
            text: "Write hello.ts",
        })

        // Store assistant message
        await memory().updateMessage({
            id: assistantMsgId,
            sessionID: sessionId,
            role: "assistant" as const,
            time: { created: now + 1 },
            parentID: userMsgId,
            modelID: "gpt-4o",
            providerID: "openai",
            mode: "build",
            agent: "build",
            path: { cwd: tmpDir, root: tmpDir },
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        })

        // Add reasoning part
        await memory().updatePart({
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: assistantMsgId,
            type: "reasoning" as const,
            text: "I should create a hello.ts file",
            time: { start: now, end: now + 500 },
        })

        // Add text part
        await memory().updatePart({
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: assistantMsgId,
            type: "text" as const,
            text: "I'll create the file for you.",
        })

        // Add tool part
        const toolPartId = PartID.ascending()
        await memory().updatePart({
            id: toolPartId,
            sessionID: sessionId,
            messageID: assistantMsgId,
            type: "tool" as const,
            callID: "call_123",
            tool: "write",
            state: {
                status: "completed" as const,
                input: { file_path: "hello.ts", content: 'console.log("hello")' },
                output: "File written successfully",
                title: "Wrote hello.ts",
                metadata: {},
                time: { start: now, end: now + 100 },
            },
        })

        // Add step-finish part
        await memory().updatePart({
            id: PartID.ascending(),
            sessionID: sessionId,
            messageID: assistantMsgId,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        })

        // Read back via page
        const result = await MessageV2.page(ctx, { sessionID: sessionId, limit: 50 })

        // Find our assistant message
        const assistantMsg = result.items.find(m => m.info.id === assistantMsgId)
        expect(assistantMsg).toBeDefined()
        expect(assistantMsg!.info.role).toBe("assistant")
        expect(assistantMsg!.parts.length).toBe(4)

        // Verify part types in order
        const types = assistantMsg!.parts.map(p => p.type)
        expect(types).toContain("reasoning")
        expect(types).toContain("text")
        expect(types).toContain("tool")
        expect(types).toContain("step-finish")

        // Verify tool part content
        const toolPart = assistantMsg!.parts.find(p => p.type === "tool") as MessageV2.ToolPart
        expect(toolPart.tool).toBe("write")
        expect(toolPart.callID).toBe("call_123")
        expect(toolPart.state.status).toBe("completed")
        if (toolPart.state.status === "completed") {
            expect(toolPart.state.output).toBe("File written successfully")
            expect(toolPart.state.title).toBe("Wrote hello.ts")
        }

        // Verify reasoning part
        const reasoningPart = assistantMsg!.parts.find(p => p.type === "reasoning") as MessageV2.ReasoningPart
        expect(reasoningPart.text).toBe("I should create a hello.ts file")
        expect(reasoningPart.time.start).toBe(now)
        expect(reasoningPart.time.end).toBe(now + 500)
    })

    it("should correctly remove a message and its parts", async () => {
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
            text: "This will be deleted",
        })

        // Remove the message
        await memory().removeMessage({ sessionID: sessionId, messageID: msgId })

        // Verify it's gone
        const result = await MessageV2.page(agent.agentContext, { sessionID: sessionId, limit: 50 })
        const found = result.items.find(m => m.info.id === msgId)
        expect(found).toBeUndefined()
    })

    it("should correctly remove a part while keeping the message", async () => {
        const msgId = MessageID.ascending()
        const partId1 = PartID.ascending()
        const partId2 = PartID.ascending()

        await memory().updateMessage({
            id: msgId,
            sessionID: sessionId,
            role: "user" as const,
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4o" },
        })

        await memory().updatePart({
            id: partId1,
            sessionID: sessionId,
            messageID: msgId,
            type: "text" as const,
            text: "Keep this",
        })

        await memory().updatePart({
            id: partId2,
            sessionID: sessionId,
            messageID: msgId,
            type: "text" as const,
            text: "Delete this",
        })

        // Remove only the second part
        await memory().removePart({ sessionID: sessionId, messageID: msgId, partID: partId2 })

        // Read back
        const result = await MessageV2.page(agent.agentContext, { sessionID: sessionId, limit: 50 })
        const msg = result.items.find(m => m.info.id === msgId)
        expect(msg).toBeDefined()
        expect(msg!.parts.length).toBe(1)
        expect((msg!.parts[0] as any).text).toBe("Keep this")
    })
})
