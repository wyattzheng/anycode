import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: Tool calling flow
 *
 * Verifies that CodeAgent correctly handles tool call events
 * when the LLM invokes a registered tool.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { TOOL_CALL_BODY, TOOL_RESULT_TEXT_BODY } from "./fixtures/tool-call-stream"
import { SqlJsStorage } from "@any-code/utils"

describe("CodeAgent tool calling", () => {
    let agent: CodeAgent
    let tmpDir: string

    beforeAll(async () => {
        tmpDir = createTempDir()

        // Track LLM call count to return different responses
        let callCount = 0

        server.use(
            http.post("*/v1/responses", () => {
                callCount++
                const body = callCount === 1 ? TOOL_CALL_BODY : TOOL_RESULT_TEXT_BODY
                return new HttpResponse(body, {
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
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
            fs: new (await import("../src/vfs-node")).NodeFS(),
            search: new NodeSearchProvider(),
            dataPath: testPaths(),
        })

        await agent.init()
    }, 60_000)

    afterAll(() => {
        cleanupTempDir(tmpDir)
    })

    // TODO: This test requires registering tools in the agent's tool registry.
    // Without registered tools, the AI SDK parses function_call SSE correctly but
    // opencode's processor can't execute unregistered tools, so no tool events are emitted.
    it.skip("should emit tool.start and tool.done events", async () => {
        
        const events: Array<{ type: string; toolName?: string; toolArgs?: any; toolOutput?: string }> = []

        for await (const event of agent.chat('Create hello.ts')) {
            events.push(event)
        }

        // Should have tool.start event
        const toolStarts = events.filter((e) => e.type === "tool.start")
        expect(toolStarts.length).toBeGreaterThan(0)

        // Should have tool.done event
        const toolDones = events.filter((e) => e.type === "tool.done")
        expect(toolDones.length).toBeGreaterThan(0)

        // Should end with done
        const lastEvent = events[events.length - 1]
        expect(lastEvent.type).toBe("done")
    })
})
