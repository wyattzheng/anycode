import { describe, it, expect } from "vitest"
import { ContextCompaction } from "../src/memory/compaction"

describe("ContextCompaction.truncateToolOutput()", () => {
    const MAX_CHARS = 40_000 * 4 // 40k tokens * 4 chars/token = 160k chars

    it("should pass through short output unchanged", () => {
        const output = "Hello, world!"
        expect(ContextCompaction.truncateToolOutput(output)).toBe(output)
    })

    it("should pass through output at exactly the limit", () => {
        const output = "x".repeat(MAX_CHARS)
        expect(ContextCompaction.truncateToolOutput(output)).toBe(output)
    })

    it("should truncate output exceeding the limit", () => {
        const output = "x".repeat(MAX_CHARS + 1000)
        const result = ContextCompaction.truncateToolOutput(output)

        expect(result.length).toBeLessThan(output.length)
        expect(result).toContain("[TRUNCATED")
        expect(result).toContain("token limit]")
        // Truncated content should start with the original prefix
        expect(result.startsWith("x".repeat(100))).toBe(true)
    })

    it("should preserve content up to the limit", () => {
        const prefix = "A".repeat(MAX_CHARS)
        const output = prefix + "B".repeat(5000)
        const result = ContextCompaction.truncateToolOutput(output)

        // Should keep exactly MAX_CHARS of original content
        expect(result.startsWith(prefix)).toBe(true)
        expect(result).not.toContain("B")
    })

    it("should handle empty string", () => {
        expect(ContextCompaction.truncateToolOutput("")).toBe("")
    })
})
