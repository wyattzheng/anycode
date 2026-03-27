import type { AgentContext } from "../context"
import { type Provider, VendorRegistry } from "@any-code/provider"
import { Skill } from "../skill"

export interface ISystemPrompt {
  instructions(model: Provider.Model): string
  provider(model: Provider.Model): string[]
  environment(model: Provider.Model, context: AgentContext): Promise<string[]>
  skills(context: AgentContext): Promise<string>
}

export class SystemPrompt implements ISystemPrompt {
  instructions(model: Provider.Model) {
    return VendorRegistry.getModelProvider({ model }).getInstructionPrompt()
  }

  provider(model: Provider.Model) {
    return VendorRegistry.getModelProvider({ model }).getProviderSystemPrompt()
  }

  async environment(model: Provider.Model, context: AgentContext) {
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

  async skills(context: AgentContext) {
    const list = await context.skill.all()

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
