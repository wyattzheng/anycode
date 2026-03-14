/**
 * Test: Permission abstraction layer
 *
 * Verifies that:
 *   1. The onPermissionRequest callback is called when a tool needs permission
 *   2. Denying permission produces a tool error (not a hang)
 *   3. The agent continues the conversation after denial
 *
 * Uses OPENCODE_PERMISSION env var to override the default "*": "allow"
 * ruleset. Sets edit: "ask" because the write tool maps to "edit" permission.
 *
 * IMPORTANT: This test uses its own tmpDir and sets OPENCODE_PERMISSION
 * BEFORE agent init to ensure Config.state() picks it up.
 */
import { describe, it, expect, afterAll } from "vitest"
import { http, HttpResponse } from "msw"
import { CodeAgent, NodeFS, type PermissionRequest } from "../src/index"
import { createTempDir, cleanupTempDir, server } from "./setup"
import { buildHelloworldFixtures } from "./fixtures/helloworld-html-stream"
import { RESPONSES_API_BODY } from "./fixtures/text-stream"

describe("CodeAgent: permission handling", () => {
    const tmpDirs: string[] = []

    afterAll(() => {
        for (const d of tmpDirs) cleanupTempDir(d)
    })

    it("should call onPermissionRequest and deny the write tool", async () => {
        // Use a fresh tmpDir so Config.state() is freshly initialized
        const tmpDir = createTempDir()
        tmpDirs.push(tmpDir)

        const permissionRequests: PermissionRequest[] = []

        // Set BEFORE agent.init() so Config.state() picks it up
        const savedPermission = process.env.OPENCODE_PERMISSION
        process.env.OPENCODE_PERMISSION = JSON.stringify({ edit: "ask" })

        try {
            const agent = new CodeAgent({
                directory: tmpDir,
                skipPlugins: true,
                fs: new NodeFS(),
                provider: {
                    id: "openai",
                    apiKey: "test-key-not-real",
                    model: "gpt-4o",
                    baseUrl: "http://localhost:19283/v1",
                },
                onPermissionRequest: async (request) => {
                    permissionRequests.push(request)
                    return "deny"
                },
            })

            await agent.init()

            let mainCallCount = 0
            const fixtures = buildHelloworldFixtures("index.html")

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
                    return new HttpResponse(
                        mainCallCount === 1 ? fixtures.toolCallBody : fixtures.confirmationBody,
                        {
                            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                        },
                    )
                }),
            )

            const session = await agent.createSession()
            const events: Array<{ type: string; content?: string; toolName?: string; error?: string }> = []

            for await (const event of agent.chat(session.id, "创建一个 index.html")) {
                events.push(event)
            }

            // Should complete (not hang!)
            const lastEvent = events[events.length - 1]
            expect(lastEvent.type).toBe("done")

            // Should have a tool_call_start for write
            const toolStarts = events.filter((e) => e.type === "tool_call_start")
            expect(toolStarts.length).toBeGreaterThan(0)
            expect(toolStarts[0].toolName).toBe("write")

            // Should have a tool error (write was denied)
            const toolErrors = events.filter(
                (e) => e.type === "error" && e.error && e.error.includes("rejected"),
            )
            expect(toolErrors.length).toBeGreaterThan(0)

            // The onPermissionRequest callback should have been called
            expect(permissionRequests.length).toBeGreaterThan(0)
        } finally {
            // Restore env
            if (savedPermission === undefined) {
                delete process.env.OPENCODE_PERMISSION
            } else {
                process.env.OPENCODE_PERMISSION = savedPermission
            }
        }
    }, 60_000)
})
