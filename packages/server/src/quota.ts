import { createHash } from "crypto"
import { VendorRegistry, type VendorOAuthState } from "@any-code/provider"
import { type AccountSettings } from "@any-code/settings"

type AccountQuotaAccount = Pick<AccountSettings, "id" | "AGENT" | "PROVIDER" | "MODEL" | "API_KEY" | "BASE_URL" | "OAUTH">

interface AccountQuotaEntry {
  signature: string
  expiresAt: number
  value: unknown
}

export class AccountQuotaManager {
  private readonly entries = new Map<string, AccountQuotaEntry>()
  private readonly refreshes = new Map<string, Promise<void>>()
  private readonly persistCredentials?: (accountId: string, credentials: { apiKey?: string; oauth?: VendorOAuthState | null }) => void | Promise<void>

  constructor(
    private readonly ttlMs: number,
    options: { persistCredentials?: (accountId: string, credentials: { apiKey?: string; oauth?: VendorOAuthState | null }) => void | Promise<void> } = {},
  ) {
    this.persistCredentials = options.persistCredentials
  }

  clear() {
    this.entries.clear()
    this.refreshes.clear()
  }

  async getForAccounts(accounts: AccountQuotaAccount[]) {
    const activeIds = new Set(accounts.map((account) => account.id))
    for (const accountId of this.entries.keys()) if (!activeIds.has(accountId)) this.entries.delete(accountId)
    for (const accountId of this.refreshes.keys()) if (!activeIds.has(accountId)) this.refreshes.delete(accountId)

    const quotas: Record<string, unknown> = {}
    for (const account of accounts) quotas[account.id] = await this.get(account)
    return quotas
  }

  private async get(account: AccountQuotaAccount) {
    const signature = this.signature(account)
    const cached = this.entries.get(account.id)
    if (cached?.signature === signature) {
      if (cached.expiresAt <= Date.now()) this.refresh(account, signature)
      return cached.value
    }
    return this.load(account, signature, null, "load")
  }

  private refresh(account: AccountQuotaAccount, signature: string) {
    if (this.refreshes.has(account.id)) return
    const promise = this.load(account, signature, this.entries.get(account.id)?.value ?? null, "refresh")
      .then(() => undefined)
      .finally(() => {
        if (this.refreshes.get(account.id) === promise) this.refreshes.delete(account.id)
      })
    this.refreshes.set(account.id, promise)
  }

  private async load(account: AccountQuotaAccount, signature: string, fallbackValue: unknown, phase: "load" | "refresh") {
    try {
      const apiKey = account.API_KEY
      if (!apiKey) {
        console.warn(`⚠  Skipping quota load for account ${account.id}: missing API key`)
        this.entries.set(account.id, { signature, expiresAt: Date.now() + this.ttlMs, value: null })
        return null
      }

      const vendor = VendorRegistry.getVendorProvider({ id: account.PROVIDER })
      const resolved = await vendor.resolveApiKey({
        apiKey,
        agent: account.AGENT,
        oauth: account.OAUTH ?? null,
      })
      const persistedApiKey = typeof resolved.persistedApiKey === "string" ? resolved.persistedApiKey.trim() : ""
      if (persistedApiKey || resolved.persistedOAuth) {
        await this.persistCredentials?.(account.id, {
          ...(persistedApiKey ? { apiKey: persistedApiKey } : {}),
          ...(resolved.persistedOAuth ? { oauth: resolved.persistedOAuth } : {}),
        })
      }

      const quota = await vendor.getQuota({
        apiKey: persistedApiKey || apiKey,
        agent: account.AGENT,
        model: account.MODEL,
        baseUrl: account.BASE_URL,
        oauth: resolved.persistedOAuth ?? account.OAUTH ?? null,
      })
      if (!quota) {
        console.warn(`⚠  Quota provider returned null for account ${account.id}`, {
          agent: account.AGENT,
          provider: account.PROVIDER,
          model: account.MODEL,
        })
      }
      this.entries.set(account.id, { signature, expiresAt: Date.now() + this.ttlMs, value: quota })
      return quota
    } catch (error) {
      console.warn(`⚠  Failed to ${phase} quota for account ${account.id}:`, error)
      if (phase === "refresh") return fallbackValue
      this.entries.set(account.id, { signature, expiresAt: Date.now() + this.ttlMs, value: fallbackValue })
      return fallbackValue
    }
  }

  private signature(account: AccountQuotaAccount) {
    return createHash("sha1").update([
      account.id,
      account.AGENT,
      account.PROVIDER,
      account.MODEL,
      account.API_KEY,
      account.BASE_URL ?? "",
      JSON.stringify(account.OAUTH ?? null),
    ].join("\u0000")).digest("hex")
  }
}
