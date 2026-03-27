import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: truncateToolOutput via full chat() flow
 *
 * Registers a custom tool that returns oversized output (>160k chars),
 * triggers it via MSW-mocked LLM tool call, and verifies the DB stores
 * truncated tool output.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { SqlJsStorage } from "../src/storage-sqljs"
import { http, HttpResponse } from "msw"
import { BIG_TOOL_CALL_BODY, BIG_TOOL_RESULT_TEXT_BODY } from "./fixtures/big-tool-stream"
import { z } from "zod"

const MAX_CHARS = 40_000 * 4 // 40k tokens * 4 chars/token

describe("truncateToolOutput via full chat()", () => {
    let agent: CodeAgent
    let tmpDir: string

    // The oversized output our custom tool will return
    const OVERSIZED_OUTPUT = "X".repeat(MAX_CHARS + 50_000)

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
            extraTools: [
                {
                    id: "big_output",
                    init: async () => ({
                        description: "Returns a very large output for testing truncation",
                        parameters: z.object({}),
                        execute: async () => ({
                            title: "",
                            output: OVERSIZED_OUTPUT,
                            metadata: {},
                        }),
                    }),
                },
            ],
        })

        await agent.init()
    }, 60_000)

    afterAll(() => {
        cleanupTempDir(tmpDir)
    })

    it("should truncate oversized tool output in DB after chat()", async () => {
        // Override MSW: first request → tool call, second request → text response
        let callCount = 0
        server.use(
            http.post("*/v1/responses", () => {
                callCount++
                const body = callCount === 1 ? BIG_TOOL_CALL_BODY : BIG_TOOL_RESULT_TEXT_BODY
                return new HttpResponse(body, {
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                    },
                })
            }),
        )

        // Run full chat flow — LLM calls big_output tool, gets truncated result
        const events: any[] = []
        for await (const event of agent.chat("Generate a big output")) {
            events.push(event)
        }

        // Query tool parts from DB via context.memory (same API the agent uses)
        const context = (agent as any)._context
        const sessionID = (agent as any)._currentSessionId
        const msgs = await context.memory.messages({ sessionID })

        // Find the completed tool part for big_output
        let toolOutput: string | undefined
        for (const msg of msgs) {
            for (const part of msg.parts) {
                if (part.type === "tool" && part.tool === "big_output" && part.state.status === "completed") {
                    toolOutput = part.state.output
                }
            }
        }

        expect(toolOutput).toBeDefined()

        // Output should be truncated (shorter than original)
        expect(toolOutput!.length).toBeLessThan(OVERSIZED_OUTPUT.length)
        // Should contain the truncation marker
        expect(toolOutput!).toContain("[TRUNCATED")
        // Truncated content should start with our data
        expect(toolOutput!.startsWith("X".repeat(100))).toBe(true)
        // Should be around MAX_CHARS + marker length
        expect(toolOutput!.length).toBeLessThan(MAX_CHARS + 200)
    })
})
