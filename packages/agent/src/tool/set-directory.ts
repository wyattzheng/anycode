import z from "zod"
import { Tool } from "./tool"

export const SetWorkingDirectoryTool = Tool.define("set_project_directory", {
  description: `Set the working directory for this session. The typical usage is to open a project repository's root directory so the full development environment (file browser, diff viewer, terminal, etc.) becomes available.

The directory must be an absolute path to an existing directory on the file system.

To switch to a different project, first call this tool with directory set to null to clear the current directory, then call it again with the new path. After clearing, you can freely set a new directory.`,
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

