/**
 * Auth stub module — original auth/ was removed during agent-mode cleanup.
 * Provides no-op implementations for Auth functions used by provider, config, etc.
 */

export const OAUTH_DUMMY_KEY = "__oauth_dummy__"

export namespace Auth {
  export type AuthInfo = {
    type: string
    key?: string
    access?: string
    refresh?: string
    expires?: number
    [key: string]: unknown
  }

  /**
   * Stub: always returns undefined (no stored auth)
   */
  export async function get(_providerID: string): Promise<AuthInfo | undefined> {
    return undefined
  }

  /**
   * Stub: returns empty auth record
   */
  export async function all(): Promise<Record<string, AuthInfo>> {
    return {}
  }

  /**
   * Stub: no-op set
   */
  export async function set(_providerID: string, _data: AuthInfo): Promise<void> {}

  /**
   * Stub: no-op remove
   */
  export async function remove(_providerID: string): Promise<void> {}
}
