import fsPromises from "fs/promises"
import path from "path"
import { NodeGitProvider } from "./git"

export interface DirEntry {
  name: string
  type: "file" | "dir"
}

interface GitChange {
  file: string
  status: string
}

const IGNORE = new Set([".git", "node_modules", ".next", "dist", ".opencode", ".anycode", ".any-code", "__pycache__", ".venv", ".DS_Store"])
const gitProvider = new NodeGitProvider()

export async function listDir(dir: string): Promise<DirEntry[]> {
  if (!dir) return []
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry: fsPromises.Dirent) => (!entry.name.startsWith(".") || entry.name === ".gitignore") && !IGNORE.has(entry.name))
      .sort((a: fsPromises.Dirent, b: fsPromises.Dirent) => {
        const ad = a.isDirectory() ? 0 : 1
        const bd = b.isDirectory() ? 0 : 1
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name)
      })
      .map((entry: fsPromises.Dirent) => ({ name: entry.name, type: entry.isDirectory() ? "dir" as const : "file" as const }))
  } catch {
    return []
  }
}

export async function getGitChanges(dir: string): Promise<GitChange[]> {
  if (!dir) return []
  try {
    const rootResult = await gitProvider.run(["rev-parse", "--show-toplevel"], { cwd: dir })
    const gitRoot = rootResult.exitCode === 0 ? rootResult.text().trim() : ""
    if (!gitRoot) return []

    const result = await gitProvider.run(["status", "--porcelain", "-uall"], { cwd: dir })
    if (result.exitCode !== 0) return []
    const text = result.text()
    if (!text.trim()) return []

    const needsFilter = path.resolve(gitRoot) !== path.resolve(dir)
    const relPrefix = needsFilter ? `${path.relative(gitRoot, dir)}/` : ""

    return text
      .split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => {
        const xy = line.slice(0, 2)
        const file = line.slice(3)
        let status = xy.trim().charAt(0) || "?"
        if (xy[0] === "?" || xy[1] === "?") status = "?"
        return { file, status }
      })
      .filter(({ file }) => !needsFilter || file.startsWith(relPrefix))
      .map(({ file, status }) => ({
        file: needsFilter ? file.slice(relPrefix.length) : file,
        status,
      }))
  } catch {
    return []
  }
}

export async function computeFileDiff(
  dir: string,
  filePath: string,
  existingContent?: string,
): Promise<{ added: number[]; removed: number[] }> {
  const added: number[] = []
  const removed: number[] = []

  let result = await gitProvider.run(["diff", "--unified=0", "--", filePath], { cwd: dir })
  if (result.exitCode !== 0 || !result.text().trim()) {
    result = await gitProvider.run(["diff", "--unified=0", "--cached", "--", filePath], { cwd: dir })
  }

  const diffText = result.text()
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm
  let match: RegExpExecArray | null
  while ((match = hunkRe.exec(diffText))) {
    const oldStart = parseInt(match[1], 10)
    const oldCount = parseInt(match[2] ?? "1", 10)
    const newStart = parseInt(match[3], 10)
    const newCount = parseInt(match[4] ?? "1", 10)
    for (let i = 0; i < oldCount; i++) removed.push(oldStart + i)
    for (let i = 0; i < newCount; i++) added.push(newStart + i)
  }

  if (!diffText.trim()) {
    try {
      const content = existingContent ?? await fsPromises.readFile(path.resolve(dir, filePath), "utf-8")
      const lineCount = content.split("\n").length
      for (let i = 1; i <= lineCount; i++) added.push(i)
    } catch {
      /* ignore */
    }
  }

  return { added, removed }
}
