import type { AgentContext } from "@/agent/context"
import path from "path"

import { Filesystem } from "../util/filesystem"
import { Log } from "../util/log"
import { Flag } from "../util/flag"
import z from "zod"

import { Scheduler } from "../util/scheduler"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const hour = 60 * 60 * 1000
  const prune = "7.days"

  function gitArgs(context: AgentContext, git: string, cmd: string[]) {
    return ["--git-dir", git, "--work-tree", context.worktree, ...cmd]
  }

  export function init(context: AgentContext) {
    Scheduler.register(context, {
      id: "snapshot.cleanup",
      interval: hour,
      run: cleanup,
      scope: "instance",
    })
  }

  export async function cleanup(context?: AgentContext) {
    if (!context) return
    if (context.project.vcs !== "git") return
    const cfg = context.config
    if (cfg.snapshot === false) return
    const git = gitdir(context)
    const exists = await Filesystem.exists(context, git)
    if (!exists) return
    const result = await context.git.run([...gitArgs(context, git, ["gc", `--prune=${prune}`])], {
      cwd: context.directory,
    })
    if (result.exitCode !== 0) {
      log.warn("cleanup failed", {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return
    }
    log.info("cleanup", { prune })
  }

  export async function track(context: AgentContext) {
    if (context.project.vcs !== "git") return
    const cfg = context.config
    if (cfg.snapshot === false) return
    const git = gitdir(context)
    if (!(await Filesystem.exists(context, git))) {
      await Filesystem.mkdir(context, git)
      await context.git.run(["init"], {
        env: {
          ...process.env,
          GIT_DIR: git,
          GIT_WORK_TREE: context.worktree,
        },
      })

      // Configure git to not convert line endings on Windows
      await context.git.run(["--git-dir", git, "config", "core.autocrlf", "false"])
      await context.git.run(["--git-dir", git, "config", "core.longpaths", "true"])
      await context.git.run(["--git-dir", git, "config", "core.symlinks", "true"])
      await context.git.run(["--git-dir", git, "config", "core.fsmonitor", "false"])
      log.info("initialized")
    }
    await add(context, git)
    const result = await context.git.run([...gitArgs(context, git, ["write-tree"])], {
      cwd: context.directory,
    })
    const hash = result.text()
    log.info("tracking", { hash, cwd: context.directory, git })
    return hash.trim()
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export async function patch(context: AgentContext, hash: string): Promise<Patch> {
    const git = gitdir(context)
    await add(context, git)
    const result = await context.git.run(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
        ...gitArgs(context, git, ["diff", "--no-ext-diff", "--name-only", hash, "--", "."]),
      ],
      {
        cwd: context.directory,
      },
    )

    // If git diff fails, return empty patch
    if (result.exitCode !== 0) {
      log.warn("failed to get diff", { hash, exitCode: result.exitCode })
      return { hash, files: [] }
    }

    const files = result.text()
    return {
      hash,
      files: files
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.join(context.worktree, x).replaceAll("\\", "/")),
    }
  }

  export async function restore(context: AgentContext, snapshot: string) {
    log.info("restore", { commit: snapshot })
    const git = gitdir(context)
    const result = await context.git.run(
      ["-c", "core.longpaths=true", "-c", "core.symlinks=true", ...gitArgs(context, git, ["read-tree", snapshot])],
      {
        cwd: context.worktree,
      },
    )
    if (result.exitCode === 0) {
      const checkout = await context.git.run(
        ["-c", "core.longpaths=true", "-c", "core.symlinks=true", ...gitArgs(context, git, ["checkout-index", "-a", "-f"])],
        {
          cwd: context.worktree,
        },
      )
      if (checkout.exitCode === 0) return
      log.error("failed to restore snapshot", {
        snapshot,
        exitCode: checkout.exitCode,
        stderr: checkout.stderr.toString(),
        stdout: checkout.stdout.toString(),
      })
      return
    }

    log.error("failed to restore snapshot", {
      snapshot,
      exitCode: result.exitCode,
      stderr: result.stderr.toString(),
      stdout: result.stdout.toString(),
    })
  }

  export async function revert(context: AgentContext, patches: Patch[]) {
    const files = new Set<string>()
    const git = gitdir(context)
    for (const item of patches) {
      for (const file of item.files) {
        if (files.has(file)) continue
        log.info("reverting", { file, hash: item.hash })
        const result = await context.git.run(
          [
            "-c",
            "core.longpaths=true",
            "-c",
            "core.symlinks=true",
            ...gitArgs(context, git, ["checkout", item.hash, "--", file]),
          ],
          {
            cwd: context.worktree,
          },
        )
        if (result.exitCode !== 0) {
          const relativePath = path.relative(context.worktree, file)
          const checkTree = await context.git.run(
            [
              "-c",
              "core.longpaths=true",
              "-c",
              "core.symlinks=true",
              ...gitArgs(context, git, ["ls-tree", item.hash, "--", relativePath]),
            ],
            {
              cwd: context.worktree,
            },
          )
          if (checkTree.exitCode === 0 && checkTree.text().trim()) {
            log.info("file existed in snapshot but checkout failed, keeping", {
              file,
            })
          } else {
            log.info("file did not exist in snapshot, deleting", { file })
            await Filesystem.remove(context, file).catch(() => {})
          }
        }
        files.add(file)
      }
    }
  }

  export async function diff(context: AgentContext, hash: string) {
    const git = gitdir(context)
    await add(context, git)
    const result = await context.git.run(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
        ...gitArgs(context, git, ["diff", "--no-ext-diff", hash, "--", "."]),
      ],
      {
        cwd: context.worktree,
      },
    )

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return ""
    }

    return result.text().trim()
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  export async function diffFull(context: AgentContext, from: string, to: string): Promise<FileDiff[]> {
    const git = gitdir(context)
    const result: FileDiff[] = []
    const status = new Map<string, "added" | "deleted" | "modified">()

    const statusesResult = await context.git.run(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
        ...gitArgs(context, git, ["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."]),
      ],
      {
        cwd: context.directory,
      },
    )
    const statuses = statusesResult.text()

    for (const line of statuses.trim().split("\n")) {
      if (!line) continue
      const [code, file] = line.split("\t")
      if (!code || !file) continue
      const kind = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified"
      status.set(file, kind)
    }

    const numstatResult = await context.git.run(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        "-c",
        "core.quotepath=false",
        ...gitArgs(context, git, ["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."]),
      ],
      {
        cwd: context.directory,
      },
    )
    const numstatLines = numstatResult.text().split(/\r?\n/).filter(Boolean)

    for (const line of numstatLines) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      const isBinaryFile = additions === "-" && deletions === "-"
      const before = isBinaryFile
        ? ""
        : (await context.git.run(
            [
              "-c",
              "core.autocrlf=false",
              "-c",
              "core.longpaths=true",
              "-c",
              "core.symlinks=true",
              ...gitArgs(context, git, ["show", `${from}:${file}`]),
            ],
          )).text()
      const after = isBinaryFile
        ? ""
        : (await context.git.run(
            [
              "-c",
              "core.autocrlf=false",
              "-c",
              "core.longpaths=true",
              "-c",
              "core.symlinks=true",
              ...gitArgs(context, git, ["show", `${to}:${file}`]),
            ],
          )).text()
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      result.push({
        file,
        before,
        after,
        additions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(deleted) ? deleted : 0,
        status: status.get(file) ?? "modified",
      })
    }
    return result
  }

  function gitdir(context: AgentContext) {
    const project = context.project
    return path.join(context.paths.data, "snapshot", project.id)
  }

  async function add(context: AgentContext, git: string) {
    await syncExclude(context, git)
    await context.git.run(
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "core.symlinks=true",
        ...gitArgs(context, git, ["add", "."]),
      ],
      {
        cwd: context.directory,
      },
    )
  }

  async function syncExclude(context: AgentContext, git: string) {
    const file = await excludes(context)
    const target = path.join(git, "info", "exclude")
    await Filesystem.mkdir(context, path.join(git, "info"))
    if (!file) {
      await Filesystem.write(context, target, "")
      return
    }
    const text = await Filesystem.readText(context, file).catch(() => "")

    await Filesystem.write(context, target, text)
  }

  async function excludes(context: AgentContext) {
    const result = await context.git.run(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
      cwd: context.worktree,
    })
    const file = result.text()
    if (!file.trim()) return
    const exists = await Filesystem.exists(context, file.trim())
    if (!exists) return
    return file.trim()
  }
}
