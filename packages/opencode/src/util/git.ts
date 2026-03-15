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
