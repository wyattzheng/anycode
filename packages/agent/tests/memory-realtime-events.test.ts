import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Real-time event emission during chat streaming
 *
 * Verifies that events are emitted IN REAL-TIME as the LLM streams
 * its response — not batched or deferred until after chat() completes.
 *
 * This is the critical invariant for AnyCode's streaming architecture:
 * the server uses agent.on() to push events to the client via WebSocket,
 * so events MUST fire immediately as they happen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "@any-code/utils"
import { MessageV2 } from "../src/memory/message-v2"

describe("Real-time event emission during chat", () => {
    let agent: CodeAgent
    let tmpDir: string

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
    }, 60_000)

    afterAll(() => cleanupTempDir(tmpDir))

    it("bus events should fire BEFORE chat() completes", async () => {
        // Track events received via agent.on() (same mechanism as server/index.ts)
        const busEvents: Array<{ type: string; time: number }> = []
        const trackedEvents = ["message.part.updated", "message.part.delta", "message.updated", "session.status", "session.error"]
        const handlers: Array<() => void> = []
        for (const evt of trackedEvents) {
            const handler = () => { busEvents.push({ type: evt, time: Date.now() }) }
            agent.on(evt, handler)
            handlers.push(() => agent.removeListener(evt, handler))
        }

        // Track chat() events received via the async generator
        const chatEvents: Array<{ type: string; time: number }> = []
        let chatDoneTime = 0

        for await (const event of agent.chat("Say Hello World")) {
            chatEvents.push({ type: event.type, time: Date.now() })
        }
        chatDoneTime = Date.now()

        handlers.forEach(fn => fn())

        // ── Assertions ──

        // 1. Bus events must have been received
        expect(busEvents.length).toBeGreaterThan(0)

        // 2. There must be message.part.updated or message.part.delta events
        //    (these are the streaming events that drive the UI)
        const streamingBusEvents = busEvents.filter(e =>
            e.type === "message.part.updated" ||
            e.type === "message.part.delta" ||
            e.type === "message.updated"
        )
        expect(streamingBusEvents.length).toBeGreaterThan(0)

        // 3. The FIRST bus event must have arrived BEFORE chat() finished
        //    (i.e., events were real-time, not batched at the end)
        const firstBusEvent = busEvents[0]
        expect(firstBusEvent.time).toBeLessThanOrEqual(chatDoneTime)

        // 4. There should be bus events arriving throughout the stream,
        //    not just at the beginning or end.
        //    We check that bus events were received while chat events were being processed.
        const firstChatEvent = chatEvents[0]

        // Bus events should have started by the time the first chat event arrived
        expect(firstBusEvent.time).toBeLessThanOrEqual(firstChatEvent.time)
    })

    it("text.delta chat events should correspond to real-time bus PartDelta events", async () => {
        const partDeltaEvents: string[] = []
        const handler = (data: any) => {
            partDeltaEvents.push(data?.delta ?? "")
        }
        agent.on("message.part.delta", handler)

        const chatDeltas: string[] = []
        let firstChatDeltaSawBusEvents = -1

        for await (const event of agent.chat("Say Hello World")) {
            if (event.type === "text.delta" && firstChatDeltaSawBusEvents === -1) {
                // At the moment we receive the first text.delta from chat(),
                // the bus should ALREADY have received the corresponding PartDelta
                firstChatDeltaSawBusEvents = partDeltaEvents.length
            }
            if (event.type === "text.delta" && event.content) {
                chatDeltas.push(event.content)
            }
        }

        agent.removeListener("message.part.delta", handler)

        // Bus must have had PartDelta events by the time first text.delta arrived in chat
        expect(firstChatDeltaSawBusEvents).toBeGreaterThan(0)

        // Both should have received content
        expect(chatDeltas.length).toBeGreaterThan(0)
        expect(partDeltaEvents.length).toBeGreaterThan(0)
    })
})
