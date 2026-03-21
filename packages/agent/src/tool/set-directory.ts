import z from "zod"
import { Tool } from "./tool"

export const SetWorkingDirectoryTool = Tool.define("set_user_watch_project", {
  description: `Let the user's frontend UI watch a project directory. This activates the file browser, diff viewer, and other project-related UI panels for the user to see and interact with.

This is NOT required before you can start working — you can read, write, and execute files without calling this tool. It only controls what the user sees in their interface. Do NOT call this tool unnecessarily.

When to call:
- After you create a new project (e.g. scaffolded with a CLI tool)
- After you clone a repository
- When the user asks to open or switch to a specific project

The directory must be an absolute path to an existing directory. To switch projects, first call with null to clear, then call again with the new path.`,
  parameters: z.object({
    directory: z.string().nullable().describe("Absolute path to the project directory. Pass null to clear the current directory."),
  }),
  async execute(params, ctx) {
    const dir = params.directory

    if (dir === null) {
      ctx.emit("directory.set", { directory: "" })
      return {
        title: "Cleared directory",
        output: "Working directory has been cleared. You can now set a new working directory.",
        metadata: {},
      }
    }

    // Check if directory is already set
    if (ctx.worktree && ctx.worktree !== "") {
      return {
        title: "Already set",
        output: `Working directory is already set to "${ctx.worktree}". You must first set it to null to clear it before setting a new one.`,
        metadata: {},
      }
    }

    // Validate using the agent's VFS
    const stat = await ctx.fs.stat(dir)
    if (!stat || !stat.isDirectory) {
      return {
        title: "Invalid path",
        output: stat
          ? `"${dir}" is not a directory. Please provide a valid directory path.`
          : `Directory "${dir}" does not exist. Please provide a valid absolute path.`,
        metadata: {},
      }
    }

    // Emit tool event — server handler calls agent.setWorkingDirectory()
    ctx.emit("directory.set", { directory: dir })

    return {
      title: `Set directory: ${dir}`,
      output: `Working directory set to "${dir}". The session is now configured to work on this project. The full development environment is now available.`,
      metadata: {},
    }
  },
})

