import { createHash } from "crypto"
import { VendorRegistry } from "@any-code/provider"
import { normalizeString, type AccountSettings } from "@any-code/settings"

interface AccountQuotaCacheEntry<T> {
  signature: string
  expiresAt: number
  value: T
}

interface AccountQuotaRefreshEntry {
  signature: string
  promise: Promise<void>
}

export interface AccountQuotaCacheReadResult<T> {
  value: T
  stale: boolean
}

export interface AccountQuotaCacheGetOptions<T> {
  fallbackValue: T
  loader: () => Promise<T>
  onError?: (phase: "load" | "refresh", error: unknown) => void
}

export interface AccountQuotaCacheGetManyOptions<Item, T> {
  getKey: (item: Item) => string
  getSignature: (item: Item) => string
  getFallbackValue: (item: Item) => T
  loader: (item: Item) => Promise<T>
  onError?: (item: Item, phase: "load" | "refresh", error: unknown) => void
}

export class AccountQuotaCache<T> {
  readonly entries = new Map<string, AccountQuotaCacheEntry<T>>()
  readonly refreshes = new Map<string, AccountQuotaRefreshEntry>()

  constructor(readonly ttlMs: number) {}

  clear() {
    this.entries.clear()
    this.refreshes.clear()
  }

  prune(activeAccountIds: Iterable<string>) {
    const active = new Set(activeAccountIds)
    for (const accountId of this.entries.keys()) {
      if (active.has(accountId)) continue
      this.entries.delete(accountId)
    }
    for (const accountId of this.refreshes.keys()) {
      if (active.has(accountId)) continue
      this.refreshes.delete(accountId)
    }
  }

  read(accountId: string, signature: string): AccountQuotaCacheReadResult<T> | null {
    const entry = this.entries.get(accountId)
    if (!entry || entry.signature !== signature) return null
    return {
      value: entry.value,
      stale: entry.expiresAt <= Date.now(),
    }
  }

  set(accountId: string, signature: string, value: T) {
    this.entries.set(accountId, {
      signature,
      expiresAt: Date.now() + this.ttlMs,
      value,
    })
  }

  async getOrLoad(accountId: string, signature: string, options: AccountQuotaCacheGetOptions<T>): Promise<T> {
    const cached = this.read(accountId, signature)
    if (cached) {
      if (cached.stale) {
        this.refreshInBackground(accountId, signature, options.loader, (error) => {
          options.onError?.("refresh", error)
        })
      }
      return cached.value
    }

    try {
      const value = await options.loader()
      this.set(accountId, signature, value)
      return value
    } catch (error) {
      options.onError?.("load", error)
      this.set(accountId, signature, options.fallbackValue)
      return options.fallbackValue
    }
  }

  async getMany<Item>(items: Iterable<Item>, options: AccountQuotaCacheGetManyOptions<Item, T>) {
    const list = Array.from(items)
    this.prune(list.map((item) => options.getKey(item)))

    const result: Record<string, T> = {}
    for (const item of list) {
      const accountId = options.getKey(item)
      const signature = options.getSignature(item)
      result[accountId] = await this.getOrLoad(accountId, signature, {
        fallbackValue: options.getFallbackValue(item),
        loader: () => options.loader(item),
        onError: (phase, error) => {
          options.onError?.(item, phase, error)
        },
      })
    }
    return result
  }

  refreshInBackground(accountId: string, signature: string, loader: () => Promise<T>, onError?: (error: unknown) => void) {
    const current = this.refreshes.get(accountId)
    if (current?.signature === signature) return

    let promise!: Promise<void>
    promise = (async () => {
      try {
        const value = await loader()
        const entry = this.entries.get(accountId)
        if (!entry || entry.signature !== signature) return
        this.set(accountId, signature, value)
      } catch (error) {
        onError?.(error)
      } finally {
        const active = this.refreshes.get(accountId)
        if (active?.promise === promise) {
          this.refreshes.delete(accountId)
        }
      }
    })()

    this.refreshes.set(accountId, { signature, promise })
  }
}

type AccountQuotaAccount = Pick<AccountSettings, "id" | "AGENT" | "PROVIDER" | "MODEL" | "API_KEY" | "BASE_URL">

export class AccountQuotaManager {
  readonly cache: AccountQuotaCache<unknown>

  constructor(ttlMs: number) {
    this.cache = new AccountQuotaCache<unknown>(ttlMs)
  }

  clear() {
    this.cache.clear()
  }

  async getForAccounts(accounts: AccountQuotaAccount[]) {
    return this.cache.getMany(accounts, {
      getKey: (account) => account.id,
      getSignature: (account) => this.getSignature(account),
      getFallbackValue: () => null,
      loader: (account) => this.load(account),
      onError: (account, phase, error) => {
        console.warn(`⚠  Failed to ${phase} quota for account ${account.id}:`, error)
      },
    })
  }

  private async load(account: AccountQuotaAccount) {
    const apiKey = normalizeString(account.API_KEY)
    if (!apiKey) return null
    return VendorRegistry.getVendorProvider({ id: account.PROVIDER }).getQuota({
      apiKey,
      agent: normalizeString(account.AGENT),
      model: normalizeString(account.MODEL),
      baseUrl: normalizeString(account.BASE_URL),
    })
  }

  private getSignature(account: AccountQuotaAccount) {
    const raw = [
      account.id,
      normalizeString(account.AGENT),
      normalizeString(account.PROVIDER),
      normalizeString(account.MODEL),
      normalizeString(account.API_KEY),
      normalizeString(account.BASE_URL),
    ].join("\u0000")
    return createHash("sha1").update(raw).digest("hex")
  }
}
