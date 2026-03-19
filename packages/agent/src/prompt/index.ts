import type { AgentContext } from "../context"
import type { Provider } from "../provider/provider"
import type { Agent } from "../agent"
import { VendorRegistry } from "../provider/vendors"
import { Skill } from "../skill"

export namespace SystemPrompt {
  export function instructions(model: Provider.Model) {
    return VendorRegistry.getVendorProvider({ model }).getInstructionPrompt()
  }

  export function provider(model: Provider.Model) {
    return VendorRegistry.getVendorProvider({ model }).getProviderSystemPrompt()
  }

  export async function environment(model: Provider.Model, context: AgentContext) {
    const project = context.project
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${context.directory}`,
        `  Workspace root folder: ${context.worktree}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${context.shell.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<directories>`,
        `  ${project.vcs === "git" && false
          ? await context.search?.tree({ cwd: context.directory, limit: 50 })
          : ""
        }`,
        `</directories>`,
      ].join("\n"),
    ]
  }

  export async function skills(context: AgentContext, agent: Agent.Info) {
    const list = await context.skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
