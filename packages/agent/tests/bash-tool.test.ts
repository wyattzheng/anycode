import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Bash tool — SSE event handling
 *
 * Verifies that the agent correctly processes bash tool call SSE events.
 * Note: tree-sitter WASM is not available in vitest, so the actual bash
 * execution errors. We verify the event flow:
 *   tool.start → error (graceful) → text response → done
 *
 * This confirms the agent properly handles tool execution failures
 * and continues the conversation loop.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { buildBashFixtures } from "./fixtures/bash-stream"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"
import { SqlJsStorage } from "@any-code/utils"

describe("CodeAgent: bash tool", () => {
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
        const { toolCallBody, confirmationBody } = buildBashFixtures()

        server.use(
            http.post("*/v1/responses", async ({ request }) => {
                const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
                const model = (body?.model ?? "") as string
                if (model !== "gpt-4o") {
                    return new HttpResponse(RESPONSES_API_BODY, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                    })
                }
                mainCallCount++
                return new HttpResponse(mainCallCount === 1 ? toolCallBody : confirmationBody, {
                    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                })
            }),
        )
    })

    it("should handle bash tool call and continue after tool error", async () => {
        
        const events: Array<{ type: string; content?: string; toolName?: string; error?: string }> = []

        for await (const event of agent.chat("执行 echo hello")) {
            events.push(event)
        }

        // Should end with done (conversation continued despite tool error)
        expect(events[events.length - 1].type).toBe("done")

        // Should have a tool.start event for bash
        const toolStarts = events.filter((e) => e.type === "tool.start")
        expect(toolStarts.length).toBeGreaterThan(0)
        expect(toolStarts[0].toolName).toBe("bash")

        // After the tool call, the conversation loop should continue
        // and the LLM should respond with text
        const textDeltas = events.filter((e) => e.type === "text.delta")
        expect(textDeltas.length).toBeGreaterThan(0)
    })
})
