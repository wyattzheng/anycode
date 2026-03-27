/**
 * Test: toModelMessages snapshot
 *
 * Verifies that MessageV2.toModelMessages() produces stable output
 * for a variety of message structures. This is the most critical safety
 * net for memory refactoring — any change to this output directly affects
 * what the LLM sees.
 */
import { describe, it, expect } from "vitest"
import { MessageV2 } from "../src/memory/message-v2"
import { SessionID, MessageID, PartID } from "../src/session/schema"
import { toModelMessages, type Provider } from "@any-code/provider"

// Minimal mock model for toModelMessages
const mockModel: Provider.Model = {
    id: "gpt-4o",
    providerID: "openai" as any,
    name: "GPT-4o",
    attachment: false,
    reasoning: { type: "disabled" },
    api: { id: "gpt-4o", npm: "@ai-sdk/openai" },
    limit: { context: 128000, output: 16384 },
    temperature: { default: 1, min: 0, max: 2 },
    topP: undefined,
} as any

function makeSessionId() { return SessionID.descending() }
function makeMsgId() { return MessageID.ascending() }
function makePartId() { return PartID.ascending() }

const SESSION_ID = makeSessionId()
const NOW = 1710000000000 // Fixed timestamp for deterministic snapshots

describe("toModelMessages snapshot", () => {
    it("pure text conversation: user → assistant", () => {
        const userMsgId = makeMsgId()
        const assistantMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Hello, what can you do?",
                    },
                ],
            },
            {
                info: {
                    id: assistantMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0.001,
                    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "text" as const,
                        text: "I can help you write code!",
                    },
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "step-finish" as const,
                        reason: "stop",
                        cost: 0.001,
                        tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()
    })

    it("conversation with tool call: user → assistant(tool) → user(result continuation)", () => {
        const userMsgId = makeMsgId()
        const assistantMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Create hello.ts",
                    },
                ],
            },
            {
                info: {
                    id: assistantMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0.002,
                    tokens: { input: 50, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
                    finish: "tool-calls",
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "text" as const,
                        text: "I'll create hello.ts for you.",
                    },
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "tool" as const,
                        callID: "call_001",
                        tool: "write",
                        state: {
                            status: "completed" as const,
                            input: { file_path: "hello.ts", content: 'console.log("hello")' },
                            output: "File written: hello.ts",
                            title: "Wrote hello.ts",
                            metadata: { lines: "1" },
                            time: { start: NOW, end: NOW + 50 },
                        },
                    },
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "step-finish" as const,
                        reason: "tool-calls",
                        cost: 0.002,
                        tokens: { input: 50, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()
    })

    it("conversation with reasoning (thinking)", () => {
        const userMsgId = makeMsgId()
        const assistantMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Explain async/await",
                    },
                ],
            },
            {
                info: {
                    id: assistantMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0.003,
                    tokens: { input: 30, output: 100, reasoning: 50, cache: { read: 0, write: 0 } },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "reasoning" as const,
                        text: "The user wants to understand async/await...",
                        time: { start: NOW, end: NOW + 1000 },
                    },
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "text" as const,
                        text: "Async/await is a syntax for handling promises...",
                    },
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "step-finish" as const,
                        reason: "stop",
                        cost: 0.003,
                        tokens: { input: 30, output: 100, reasoning: 50, cache: { read: 0, write: 0 } },
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()
    })

    it("assistant with error should be skipped", () => {
        const userMsgId = makeMsgId()
        const errMsgId = makeMsgId()
        const goodMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Do something",
                    },
                ],
            },
            {
                info: {
                    id: errMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1, completed: NOW + 2 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    error: { name: "UnknownError" as const, data: { message: "API timeout" } },
                },
                parts: [], // No parts → should be skipped
            },
            {
                info: {
                    id: goodMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 3 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0.001,
                    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: goodMsgId,
                        type: "text" as const,
                        text: "Here's the result",
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()

        // Verify error message was skipped — output should have user + assistant (good only)
        // ModelMessages don't have the same structure, but we can check count
        const assistantMsgs = result.filter((m: any) => m.role === "assistant")
        expect(assistantMsgs.length).toBe(1)
    })

    it("tool with error state", () => {
        const userMsgId = makeMsgId()
        const assistantMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Run tests",
                    },
                ],
            },
            {
                info: {
                    id: assistantMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0.001,
                    tokens: { input: 20, output: 30, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "tool" as const,
                        callID: "call_err",
                        tool: "bash",
                        state: {
                            status: "error" as const,
                            input: { command: "npm test" },
                            error: "Command failed with exit code 1",
                            time: { start: NOW, end: NOW + 200 },
                        },
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()
    })

    it("pending/running tool gets treated as interrupted", () => {
        const userMsgId = makeMsgId()
        const assistantMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "text" as const,
                        text: "Do work",
                    },
                ],
            },
            {
                info: {
                    id: assistantMsgId,
                    sessionID: SESSION_ID,
                    role: "assistant" as const,
                    time: { created: NOW + 1 },
                    parentID: userMsgId,
                    modelID: "gpt-4o" as any,
                    providerID: "openai" as any,
                    mode: "build",
                    agent: "build",
                    path: { cwd: "/tmp", root: "/tmp" },
                    cost: 0,
                    tokens: { input: 10, output: 15, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: assistantMsgId,
                        type: "tool" as const,
                        callID: "call_pending",
                        tool: "bash",
                        state: {
                            status: "running" as const,
                            input: { command: "long-running-task" },
                            time: { start: NOW },
                        },
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()
    })

    it("compaction message inserts 'What did we do so far?'", () => {
        const userMsgId = makeMsgId()

        const input: MessageV2.WithParts[] = [
            {
                info: {
                    id: userMsgId,
                    sessionID: SESSION_ID,
                    role: "user" as const,
                    time: { created: NOW },
                    agent: "build",
                    model: { providerID: "openai" as any, modelID: "gpt-4o" as any },
                },
                parts: [
                    {
                        id: makePartId(),
                        sessionID: SESSION_ID,
                        messageID: userMsgId,
                        type: "compaction" as const,
                        auto: true,
                    },
                ],
            },
        ]

        const result = toModelMessages(input, mockModel)
        expect(result).toMatchSnapshot()

        // Verify the compaction text is present
        const userMsg = result.find((m: any) => m.role === "user")
        expect(userMsg).toBeDefined()
        const content = JSON.stringify(userMsg)
        expect(content).toContain("What did we do so far?")
    })
})
