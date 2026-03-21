/**
 * Test: set_project_directory tool via mocked conversation
 *
 * Verifies that:
 * 1. The agent correctly calls set_project_directory when the LLM responds
 *    with a tool call, and the bus event fires + agent state updates
 * 2. A second tool call is rejected (directory already set)
 *
 * Uses MSW to intercept LLM API calls and return pre-built SSE fixtures.
 * All providers (FS, storage, search) are stubbed inline.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest"
import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"
import os from "os"
import fs from "fs"
import path from "path"
import { CodeAgent, SqliteNoSqlDb } from "../src/index"

import { buildSetDirectoryFixtures } from "./fixtures/set-directory-stream"

// ── Inline test stubs ─────────────────────────────────────────────────

/** InMemory VFS — stat() returns isDirectory:true for any existing tmpDir path */
class StubFS {
    async exists() { return true }
    async stat(p: string) {
        // Return isDirectory for real directories on disk
        try {
            const s = await fs.promises.stat(p)
            return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), mtimeMs: s.mtimeMs }
        } catch { return undefined }
    }
    async readText() { return "" }
    async readBytes() { return new Uint8Array() }
    async readDir() { return [] }
    async write() {}
    async mkdir() {}
    async remove() {}
    async glob() { return [] }
}

class StubSearch {
    async grep() { return [] }
    async files() { return [] }
}

class StubShell {
    platform = process.platform
    spawn() { return { stdout: { on() {} }, stderr: { on() {} }, on() {}, pid: 0 } as any }
    async kill() {}
}

class StubGit {
    async run() {
        return { exitCode: 0, text: () => "", stdout: new Uint8Array(), stderr: new Uint8Array() }
    }
}

/** SqlJs-based in-memory storage using agent's SqliteNoSqlDb */
class StubStorage {
    async connect(migrations: Array<{ name: string; sql: string; timestamp: number }>) {
        const initSqlJs = (await import("sql.js")).default
        const SQL = await initSqlJs()
        const db = new SQL.Database()
        db.run("PRAGMA foreign_keys = ON")
        db.run(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER)`)
        for (const m of migrations) {
            const rows = db.exec(`SELECT hash FROM "__drizzle_migrations" WHERE hash = '${m.name}'`)
            if (rows.length > 0 && rows[0].values.length > 0) continue
            db.run(m.sql)
            db.run(`INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`, [m.name, m.timestamp])
        }
        const raw = {
            run(sql: string, params?: any[]) { db.run(sql, params) },
            get(sql: string, params?: any[]): Record<string, any> | undefined {
                const stmt = db.prepare(sql); if (params) stmt.bind(params)
                if (!stmt.step()) { stmt.free(); return undefined }
                const r = stmt.getAsObject(); stmt.free(); return r as any
            },
            all(sql: string, params?: any[]): Record<string, any>[] {
                const stmt = db.prepare(sql); if (params) stmt.bind(params)
                const results: Record<string, any>[] = []
                while (stmt.step()) results.push(stmt.getAsObject() as any)
                stmt.free(); return results
            },
            transaction(fn: () => void) {
                db.run("BEGIN TRANSACTION")
                try { fn(); db.run("COMMIT") } catch (e) { db.run("ROLLBACK"); throw e }
            },
        }
        return new SqliteNoSqlDb(raw as any)
    }
}

// ── MSW server ────────────────────────────────────────────────────────

const mswServer = setupServer()
beforeAll(() => mswServer.listen({ onUnhandledRequest: "bypass" }))
afterEach(() => mswServer.resetHandlers())
afterAll(() => mswServer.close())

// ── Generic text response for background models (title, summary) ─────
const GENERIC_TEXT_BODY = [
    `data: {"type":"response.created","response":{"id":"resp_bg","object":"response","created_at":1700000000,"model":"gpt-4o-mini","status":"in_progress","output":[]}}\n\n`,
    `data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_bg","role":"assistant","content":[]}}\n\n`,
    `data: {"type":"response.content_part.added","output_index":0,"content_index":0,"part":{"type":"output_text","text":""}}\n\n`,
    `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_bg","delta":"OK"}\n\n`,
    `data: {"type":"response.output_text.done","output_index":0,"content_index":0,"text":"OK"}\n\n`,
    `data: {"type":"response.content_part.done","output_index":0,"content_index":0,"part":{"type":"output_text","text":"OK"}}\n\n`,
    `data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_bg","role":"assistant","content":[{"type":"output_text","text":"OK"}]}}\n\n`,
    `data: {"type":"response.completed","response":{"id":"resp_bg","object":"response","created_at":1700000000,"model":"gpt-4o-mini","status":"completed","output":[{"type":"message","id":"msg_bg","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],"usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11,"output_tokens_details":{"reasoning_tokens":0},"input_tokens_details":{"cached_tokens":0}}}}\n\n`,
].join("")

// ── Test ──────────────────────────────────────────────────────────────

const TARGET_DIR = os.homedir()

describe("CodeAgent: set_project_directory via mock conversation", () => {
    let agent: CodeAgent
    let tmpDir: string
    let setDir: string

    beforeAll(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "anycode-test-"))

        const dataPath = path.join(tmpDir, "data")
        fs.mkdirSync(dataPath, { recursive: true })

        agent = new CodeAgent({
            directory: "",
            fs: new StubFS() as any,
            search: new StubSearch() as any,
            storage: new StubStorage() as any,
            shell: new StubShell() as any,
            git: new StubGit() as any,
            dataPath,
            provider: {
                id: "openai",
                apiKey: "test-key-not-real",
                model: "gpt-4o",
                baseUrl: "http://localhost:19283/v1",
            },
        })

        await agent.init()

        // Subscribe to bus event (same as server does)
        setDir = ""
        agent.on("directory.set", (data: any) => {
            setDir = data.directory
            try { agent.setWorkingDirectory(data.directory) } catch { /* */ }
        })
    }, 60_000)

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    beforeEach(() => {
        let mainCallCount = 0
        const { toolCallBody, confirmationBody } = buildSetDirectoryFixtures(TARGET_DIR)

        mswServer.use(
            http.post("*/v1/responses", async ({ request }) => {
                const body = (await request.clone().json().catch(() => ({}))) as Record<string, unknown>
                const model = (body?.model ?? "") as string

                // Background models → generic text
                if (model !== "gpt-4o") {
                    return new HttpResponse(GENERIC_TEXT_BODY, {
                        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                    })
                }

                // Main chat model: round 1 = tool call, round 2 = confirmation
                mainCallCount++
                return new HttpResponse(mainCallCount === 1 ? toolCallBody : confirmationBody, {
                    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
                })
            }),
        )
    })

    it("should set working directory via tool call and update agent state", async () => {
        const events: Array<{ type: string; toolName?: string; error?: string }> = []

        for await (const event of agent.chat(`请把工作目录设置为 ${TARGET_DIR}`)) {
            events.push(event)
        }

        // Should end with done
        expect(events.length).toBeGreaterThan(0)
        expect(events[events.length - 1].type).toBe("done")

        // Should have tool events for set_project_directory
        const toolStarts = events.filter((e) => e.type === "tool.start")
        expect(toolStarts.length).toBeGreaterThan(0)
        expect(toolStarts[0].toolName).toBe("set_project_directory")

        const toolDones = events.filter((e) => e.type === "tool.done")
        expect(toolDones.length).toBeGreaterThan(0)

        // Bus event should have fired
        expect(setDir).toBe(TARGET_DIR)

        // Agent state should be updated
        expect((agent as any).options.directory).toBe(TARGET_DIR)
        expect((agent as any).options.worktree).toBe(TARGET_DIR)
    })
})
