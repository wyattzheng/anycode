import { testPaths, testNodeDeps } from "./_test-paths"
/**
 * Test: getUsage() — aggregates token/cost from step-finish parts in DB
 *
 * Runs a full chat() flow against MSW-mocked LLM, then verifies
 * that getUsage() returns correct totals from the DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { CodeAgent, NodeFS, NodeSearchProvider } from "../src/index"
import { createTempDir, cleanupTempDir } from "./setup"
import { SqlJsStorage } from "@any-code/utils"

describe("CodeAgent.getUsage()", () => {
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

    afterAll(() => {
        cleanupTempDir(tmpDir)
    })

    it("should return zero usage before any chat", async () => {
        const usage = await agent.getUsage()
        expect(usage.totalSteps).toBe(0)
        expect(usage.totalTokens.input).toBe(0)
        expect(usage.totalTokens.output).toBe(0)
        expect(usage.totalCost).toBe(0)
    })

    it("should aggregate usage after a chat() round-trip", async () => {
        // Run a full chat flow (MSW returns usage: input_tokens=10, output_tokens=8)
        for await (const event of agent.chat("Say hello")) {
            // drain events
        }

        const usage = await agent.getUsage()

        // Should have at least 1 step (one LLM call)
        expect(usage.totalSteps).toBeGreaterThanOrEqual(1)

        // Tokens should be populated from the API response
        expect(usage.totalTokens.input).toBeGreaterThan(0)
        expect(usage.totalTokens.output).toBeGreaterThan(0)

        // Structure check
        expect(usage).toHaveProperty("totalSteps")
        expect(usage).toHaveProperty("totalTokens")
        expect(usage).toHaveProperty("totalCost")
        expect(usage.totalTokens).toHaveProperty("reasoning")
        expect(usage.totalTokens).toHaveProperty("cache")
        expect(usage.totalTokens.cache).toHaveProperty("read")
        expect(usage.totalTokens.cache).toHaveProperty("write")
    })

    it("should accumulate usage across multiple chat() calls", async () => {
        const usageBefore = await agent.getUsage()
        const stepsBefore = usageBefore.totalSteps
        const inputBefore = usageBefore.totalTokens.input

        // Second chat
        for await (const event of agent.chat("Say goodbye")) {
            // drain events
        }

        const usageAfter = await agent.getUsage()

        // Steps and tokens should have increased
        expect(usageAfter.totalSteps).toBeGreaterThan(stepsBefore)
        expect(usageAfter.totalTokens.input).toBeGreaterThan(inputBefore)
    })

    it("getContext() should return context window status", async () => {
        const ctx = await agent.getContext()

        // Structure check
        expect(ctx).toHaveProperty("contextUsed")
        expect(ctx).toHaveProperty("contextLimit")
        expect(ctx).toHaveProperty("compactionThreshold")
        expect(ctx).toHaveProperty("compactions")

        // After chat, contextUsed should be > 0
        expect(ctx.contextUsed).toBeGreaterThan(0)

        // Compaction threshold should be less than context limit
        if (ctx.contextLimit > 0) {
            expect(ctx.compactionThreshold).toBeLessThan(ctx.contextLimit)
            expect(ctx.compactionThreshold).toBeGreaterThan(0)
        }

        // No compactions should have occurred in a short test
        expect(ctx.compactions).toBe(0)
    })
})
