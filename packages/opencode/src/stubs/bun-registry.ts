/**
 * PackageRegistry stub — original bun/registry was removed during agent-mode cleanup.
 * Used by config.ts for checking outdated packages.
 */

export namespace PackageRegistry {
  export async function isOutdated(_pkg: string, _version: string, _dir: string): Promise<boolean> {
    return false
  }
}
