/**
 * GitProvider — pluggable git command executor.
 *
 * The interface is intentionally minimal — just `run(args, opts)`.
 * All git subcommands are passed as raw string arguments, preserving
 * the original git CLI semantics without any abstraction layer.
 */
export interface GitResult {
  exitCode: number
  text(): string
  stdout: Buffer
  stderr: Buffer
}

export interface GitProvider {
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<GitResult>
}

/**
 * Default GitProvider backed by the local `git` binary.
 * Uses child_process.execFile for reliable argument handling.
 */
export class NodeGitProvider implements GitProvider {
  async run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
    const { execFile } = await import("child_process")
    return new Promise<GitResult>((resolve) => {
      execFile("git", args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer",
      }, (error, stdout, stderr) => {
        const stdoutBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "")
        const stderrBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "")
        resolve({
          exitCode: error ? (error as any).code ?? 1 : 0,
          text: () => stdoutBuf.toString(),
          stdout: stdoutBuf,
          stderr: stderrBuf,
        })
      })
    })
  }
}
