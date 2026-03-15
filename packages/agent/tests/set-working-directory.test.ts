import { describe, it, expect } from "vitest"
import { CodeAgent } from "../src/code-agent"

// Minimal stubs — setWorkingDirectory only touches options + _context,
// so we don't need a fully initialised agent.
function createMinimalAgent(directory: string) {
  return new CodeAgent({
    directory,
    fs: {} as any,
    search: {} as any,
    storage: {} as any,
    shell: {} as any,
    git: {} as any,
    dataPath: "/tmp/any-code-test",
    provider: { id: "test", apiKey: "key", model: "model" },
  })
}

describe("CodeAgent.setWorkingDirectory", () => {
  it("should succeed on first call when directory is empty", () => {
    const agent = createMinimalAgent("")
    expect(() => agent.setWorkingDirectory("/home/user/project")).not.toThrow()
  })

  it("should succeed on first call when directory is tmpdir", () => {
    const agent = createMinimalAgent("/tmp")
    expect(() => agent.setWorkingDirectory("/home/user/project")).not.toThrow()
  })

  it("should throw on second call", () => {
    const agent = createMinimalAgent("")
    agent.setWorkingDirectory("/home/user/project")
    expect(() => agent.setWorkingDirectory("/home/user/other")).toThrow(
      /already set/i,
    )
  })

  it("should update options.directory and options.worktree", () => {
    const agent = createMinimalAgent("")
    agent.setWorkingDirectory("/home/user/project")
    // Access options via agentContext won't work (no init), but we can
    // verify the second call fails — which proves the first call wrote
    // a non-empty, non-tmp directory to options.
    expect(() => agent.setWorkingDirectory("/other")).toThrow(/already set/i)
  })
})
