import type { GitProvider, GitResult } from "@any-code/opencode"
import { execFile } from "child_process"

/**
 * Default GitProvider backed by the local `git` binary.
 * Uses child_process.execFile for reliable argument handling.
 */
export class NodeGitProvider implements GitProvider {
    async run(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
        return new Promise<GitResult>((resolve) => {
            execFile("git", args, {
                cwd: opts.cwd,
                env: opts.env ? { ...process.env, ...opts.env } : undefined,
                maxBuffer: 50 * 1024 * 1024,
                encoding: "buffer",
            }, (error: Error | null, stdout: Buffer | string, stderr: Buffer | string) => {
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

export type { GitProvider, GitResult }
