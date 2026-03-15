import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Error retry (SessionRetry)
 *
 * Verifies that the agent retries on transient API errors.
 * The mock returns HTTP 429 (rate limited) on first call,
 * then succeeds on subsequent calls.
 *
 * This tests the SessionProcessor's retry mechanism:
 *   error → delay → retry → success
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"
import { SqlJsStorage } from "../src/storage-sqljs"

describe("CodeAgent: error retry", () => {
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

    beforeEach(() => {
        let mainCallCount = 0

        server.use(
            http.post("*/v1/responses", async ({ request }) => {
                const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
                const model = (body?.model ?? "") as string

                // Background models get generic response
                if (model !== "gpt-4o") {
                    return new HttpResponse(RESPONSES_API_BODY, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                    })
                }

                mainCallCount++

                // First call for main model: return 429 (rate limited)
                if (mainCallCount === 1) {
                    return new HttpResponse(
                        JSON.stringify({
                            error: {
                                message: "Rate limit exceeded",
                                type: "rate_limit_error",
                                code: "rate_limit_exceeded",
                            },
                        }),
                        {
                            status: 429,
                            headers: {
                                "Content-Type": "application/json",
                                "retry-after": "1",
                            },
                        },
                    )
                }

                // Subsequent calls: success
                return new HttpResponse(RESPONSES_API_BODY, {
                    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                })
            }),
        )
    })

    it("should retry after transient API error and eventually succeed", async () => {
        const session = await agent.createSession()
        const events: Array<{ type: string; content?: string; error?: string }> = []

        for await (const event of agent.chat(session.id, "你好")) {
            events.push(event)
        }

        // Conversation should eventually succeed (done event)
        const lastEvent = events[events.length - 1]
        expect(lastEvent.type).toBe("done")

        // Should have text content from the successful retry
        const textDeltas = events.filter((e) => e.type === "text.delta")
        expect(textDeltas.length).toBeGreaterThan(0)
    }, 30_000) // Allow time for retry delay
})
