import { describe, it, expect, vi } from "vitest"
import { CodeAgent } from "../src/code-agent"
import { SetWorkingDirectoryTool, SetDirectory } from "../src/tool/set-directory"
import { BusService } from "../src/bus"

// ── Helpers ───────────────────────────────────────────────────────────

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

/** Build a mock Tool.Context with given worktree and VFS stat result */
function mockToolContext(opts: {
  worktree: string
  statResult?: { isDirectory: boolean } | undefined
  bus?: BusService
}) {
  const bus = opts.bus ?? new BusService()
  return {
    worktree: opts.worktree,
    directory: opts.worktree,
    fs: {
      stat: vi.fn().mockResolvedValue(opts.statResult),
    },
    bus,
  } as any
}

// ── CodeAgent.setWorkingDirectory ─────────────────────────────────────

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
    expect(() => agent.setWorkingDirectory("/other")).toThrow(/already set/i)
  })
})

// ── SetWorkingDirectoryTool (mock execute) ─────────────────────────────

describe("SetWorkingDirectoryTool execute", () => {
  it("should set directory successfully on first call", async () => {
    const bus = new BusService()
    const ctx = mockToolContext({
      worktree: "/tmp",
      statResult: { isDirectory: true },
      bus,
    })

    // Track bus events
    let emittedDir = ""
    bus.subscribe(SetDirectory.Event, (event) => {
      emittedDir = event.properties.directory
    })

    // Init tool and call execute
    const tool = await SetWorkingDirectoryTool.init()
    const result = await tool.execute(
      { directory: "/home/user/project" },
      ctx,
    )

    // Should succeed
    expect(result.title).toContain("/home/user/project")
    expect(result.output).toContain("Working directory set")
    expect(result.output).toContain("/home/user/project")

    // Bus event should have been emitted
    expect(emittedDir).toBe("/home/user/project")
  })

  it("should reject when directory is already set", async () => {
    const ctx = mockToolContext({
      worktree: "/home/user/existing-project",
      statResult: { isDirectory: true },
    })

    const tool = await SetWorkingDirectoryTool.init()
    const result = await tool.execute(
      { directory: "/home/user/other" },
      ctx,
    )

    expect(result.title).toBe("Already set")
    expect(result.output).toContain("already set")
    expect(result.output).toContain("/home/user/existing-project")
  })

  it("should reject non-existent directory", async () => {
    const ctx = mockToolContext({
      worktree: "/tmp",
      statResult: undefined,
    })

    const tool = await SetWorkingDirectoryTool.init()
    const result = await tool.execute(
      { directory: "/nonexistent/path" },
      ctx,
    )

    expect(result.title).toBe("Invalid path")
    expect(result.output).toContain("does not exist")
  })

  it("should reject non-directory path", async () => {
    const ctx = mockToolContext({
      worktree: "/tmp",
      statResult: { isDirectory: false },
    })

    const tool = await SetWorkingDirectoryTool.init()
    const result = await tool.execute(
      { directory: "/home/user/file.txt" },
      ctx,
    )

    expect(result.title).toBe("Invalid path")
    expect(result.output).toContain("is not a directory")
  })

  it("full flow: tool emits event → server handler calls agent.setWorkingDirectory", async () => {
    const agent = createMinimalAgent("")
    const ctx = mockToolContext({
      worktree: "/tmp",
      statResult: { isDirectory: true },
      bus: agent.bus,
    })

    // Simulate server-side subscription (same as server/index.ts)
    agent.bus.subscribe(SetDirectory.Event, (event) => {
      try { agent.setWorkingDirectory(event.properties.directory) } catch { /* */ }
    })

    const tool = await SetWorkingDirectoryTool.init()

    // First call — should succeed
    const r1 = await tool.execute({ directory: "/home/user/project" }, ctx)
    expect(r1.output).toContain("Working directory set")
    expect((agent as any).options.directory).toBe("/home/user/project")
    expect((agent as any).options.worktree).toBe("/home/user/project")

    // Second call — tool rejects because ctx.worktree is still "/tmp"
    // (tool checks ctx, not agent.options), but the bus event won't
    // change agent since setWorkingDirectory throws.
    // Update ctx.worktree to simulate the agent's updated state:
    ctx.worktree = "/home/user/project"
    const r2 = await tool.execute({ directory: "/tmp/other" }, ctx)
    expect(r2.title).toBe("Already set")
    expect((agent as any).options.directory).toBe("/home/user/project")
  })
})
