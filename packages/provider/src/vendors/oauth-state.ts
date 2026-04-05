import type { VendorOAuthState } from "./types"

const text = (value: unknown) => typeof value === "string" ? value.trim() : ""
const OAUTH_FIELDS = ["accessToken", "refreshToken", "idToken", "expiresAt", "clientId", "scope", "updatedAt"] as const

export class OAuthTokenState {
  readonly value: VendorOAuthState

  constructor(provider: string, state: Partial<VendorOAuthState> = {}) {
    this.value = OAuthTokenState.read(provider, state) ?? { provider: text(provider) }
  }

  static read(provider: string, state: Partial<VendorOAuthState> | null | undefined) {
    const providerId = text(provider)
    if (!providerId || !state || typeof state !== "object") return null
    const source = state as Record<string, unknown>
    const value: VendorOAuthState = { provider: providerId }
    for (const key of OAUTH_FIELDS) {
      const next = text(source[key])
      if (next) value[key] = next
    }
    return Object.keys(value).length > 1 ? value : null
  }

  static from(provider: string, state: Partial<VendorOAuthState> | null | undefined) {
    const value = OAuthTokenState.read(provider, state)
    return value ? new OAuthTokenState(provider, value) : null
  }

  get accessToken() { return this.value.accessToken }
  get refreshToken() { return this.value.refreshToken }
  get idToken() { return this.value.idToken }

  get expiresAtMs() {
    return this.value.expiresAt ? Date.parse(this.value.expiresAt) : undefined
  }

  isAccessTokenFresh(bufferMs = 0) {
    if (!this.value.accessToken) return false
    return !this.expiresAtMs || this.expiresAtMs > Date.now() + bufferMs
  }

  withPatch(patch: Partial<VendorOAuthState>) {
    return new OAuthTokenState(this.value.provider, { ...this.value, ...patch, updatedAt: new Date().toISOString() })
  }

  toJSON() {
    return { ...this.value }
  }
}
