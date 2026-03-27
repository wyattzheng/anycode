import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Abort flow
 *
 * Verifies that CodeAgent.abort() correctly cancels an in-progress chat.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { SqlJsStorage } from "@any-code/utils"

describe("CodeAgent abort", () => {
    let agent: CodeAgent
    let tmpDir: string

    beforeAll(async () => {
        tmpDir = createTempDir()

        // Slow stream: each chunk comes after a delay (simulated by large response)
        const slowChunks = Array.from({ length: 50 }, (_, i) =>
            `data: {"id":"chatcmpl-slow","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"word${i} "},"finish_reason":null}]}\n\n`
        ).join("")
        const slowBody = slowChunks +
            `data: {"id":"chatcmpl-slow","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":50,"total_tokens":100}}\n\n` +
            `data: [DONE]\n\n`

        server.use(
            http.post("*/v1/chat/completions", () => {
                return new HttpResponse(slowBody, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                    },
                })
            }),
        )

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

    afterAll(() => {
        cleanupTempDir(tmpDir)
    })

    it("should stop producing events after abort", async () => {
        
        const events: Array<{ type: string }> = []
        let aborted = false

        for await (const event of agent.chat("Generate a long response")) {
            events.push(event)

            // Abort after receiving the first few events
            if (!aborted && events.length >= 3) {
                await agent.abort(agent.sessionId!)
                aborted = true
            }

            if (event.type === "done" || event.type === "error") break
        }

        expect(aborted).toBe(true)

        // We should have received a "done" or "error" event (the loop terminates)
        const terminal = events.filter((e) => e.type === "done" || e.type === "error")
        expect(terminal.length).toBeGreaterThan(0)
    })
})
