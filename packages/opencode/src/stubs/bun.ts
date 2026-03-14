/**
 * BunProc stub module — original bun/ was removed during agent-mode cleanup.
 * Used by plugin/index.ts and provider/provider.ts for package installation.
 */

export namespace BunProc {
  /**
   * Stub: no-op install — returns empty string (plugin loading will skip)
   */
  export async function install(_pkg: string, _version: string): Promise<string> {
    return ""
  }

  /**
   * Stub: no-op run
   */
  export async function run(_args: string[], _opts?: Record<string, unknown>): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
    return { code: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }
  }
}
