import { testPaths } from "./_test-paths"
/**
 * Test: Multi-agent isolation
 *
 * Verifies that two CodeAgent instances with the SAME directory
 * have completely isolated state (VFS, config, InMemoryFS, etc.).
 *
 * This ensures state isolation works correctly via context.state Map.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeFS } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { InMemoryFS } from "./fixtures/in-memory-fs"
import { buildHelloworldFixtures } from "./fixtures/helloworld-html-stream"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"
import { SqlJsStorage } from "../src/storage-sqljs"

describe("CodeAgent: multi-agent isolation", () => {
    let tmpDir: string

    beforeAll(() => {
        tmpDir = createTempDir()
    })

    afterAll(() => cleanupTempDir(tmpDir))

    it("should create independent agents", () => {
        const agent1 = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: new NodeFS(),
            paths: testPaths(),
            provider: { id: "openai", apiKey: "key1", model: "gpt-4o" },
        })
        const agent2 = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: new NodeFS(),
            paths: testPaths(),
            provider: { id: "openai", apiKey: "key2", model: "gpt-4o" },
        })

        expect(agent1).toBeDefined()
        expect(agent2).toBeDefined()
        expect(agent1).not.toBe(agent2)
    })

    it("should isolate VFS between agents with same directory", async () => {
        const memFS1 = new InMemoryFS()
        const memFS2 = new InMemoryFS()

        const fixtures = buildHelloworldFixtures("agent1.html")

        let callCount1 = 0
        server.use(
            http.post("*/v1/responses", async ({ request }) => {
                const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
                const model = (body?.model ?? "") as string
                if (model !== "gpt-4o") {
                    return new HttpResponse(RESPONSES_API_BODY, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                    })
                }
                callCount1++
                return new HttpResponse(
                    callCount1 === 1 ? fixtures.toolCallBody : fixtures.confirmationBody,
                    {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                    },
                )
            }),
        )

        const agent1 = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: memFS1,
            paths: testPaths(),
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
        })

        const agent2 = new CodeAgent({
            storage: new SqlJsStorage(),
            directory: tmpDir,
            skipPlugins: true,
            fs: memFS2,
            paths: testPaths(),
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
        })

        // Initialize both agents — they should NOT share Instance state
        await agent1.init()
        await agent2.init()

        // Agent1 writes a file
        const session1 = await agent1.createSession()
        for await (const _event of agent1.chat(session1.id, "创建 agent1.html")) {
            // consume
        }

        // Agent1's memFS should have the file
        const agent1Paths = memFS1.getWrittenPaths()

        // Agent2's memFS should be empty — it never ran a chat
        const agent2Paths = memFS2.getWrittenPaths()

        expect(agent1Paths.length).toBeGreaterThan(0)
        expect(agent2Paths.length).toBe(0)
    }, 60_000)
})
