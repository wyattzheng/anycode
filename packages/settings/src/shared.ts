import type { VendorOAuthState } from "@any-code/provider"
import { getVendorBrandVendor, getVendorDefaultBaseUrl, getVendorDefaultModel, getVendorOAuthUi, type VendorOAuthUiConfig } from "@any-code/provider/vendor-metadata"

export const ANYCODE_DIR_NAME = ".anycode"
export const SETTINGS_FILE_NAME = "settings.json"
export const DEFAULT_AGENT = "anycode"
export const DEFAULT_PROVIDER = "anthropic"
export const DEFAULT_MODEL = getVendorDefaultModel(DEFAULT_PROVIDER) ?? "claude-opus-4-6"
export const DEFAULT_BASE_URL = getVendorDefaultBaseUrl(DEFAULT_PROVIDER) ?? "https://api.anthropic.com/v1"
export const DEFAULT_PROVIDER_OPTIONS = ["anthropic", "openai", "google", "litellm"] as const
export const REASONING_EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh"] as const
export const DEFAULT_REASONING_EFFORT = "xhigh"
export const SERVICE_TIER_OPTIONS = ["fast", "flex"] as const

const FORCED_PROVIDER_BY_AGENT = {
  claudecode: "anthropic",
  codex: "openai",
  antigravity: "antigravity",
} as const

export interface AccountSettings {
  id: string
  name: string
  AGENT: string
  PROVIDER: string
  MODEL: string
  REASONING_EFFORT: string
  SERVICE_TIER?: string
  API_KEY: string
  BASE_URL?: string
  OAUTH?: VendorOAuthState
}

export interface UserSettingsFile extends Record<string, any> {
  accounts?: AccountSettings[]
  currentAccountId?: string | null
  MODEL?: string
  REASONING_EFFORT?: string
  SERVICE_TIER?: string
  TLS_CERT?: string
  TLS_KEY?: string
  AGENT?: string
  PROVIDER?: string
  API_KEY?: string
  BASE_URL?: string
}

export interface RuntimeSettings {
  agent: string
  provider: string
  model: string
  reasoningEffort: string
  serviceTier?: string
  apiKey: string
  baseUrl: string
  currentAccount: AccountSettings | null
  userSettings: UserSettingsFile
}
const text = (value: unknown) => typeof value === "string" ? value.trim() : ""
const maybe = (value: unknown) => text(value) || undefined
const accountNameKey = (value: unknown) => text(value).toLocaleLowerCase()
const reasoningEffort = (value: unknown) => REASONING_EFFORT_OPTIONS.includes(text(value) as typeof REASONING_EFFORT_OPTIONS[number]) ? text(value) : DEFAULT_REASONING_EFFORT
const serviceTier = (value: unknown) => SERVICE_TIER_OPTIONS.includes(text(value).toLowerCase() as typeof SERVICE_TIER_OPTIONS[number]) ? text(value).toLowerCase() : undefined
const OAUTH_KEYS = ["accessToken", "refreshToken", "idToken", "expiresAt", "clientId", "scope", "updatedAt"] as const

function createAccountId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID()
  return `account-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
function cloneAccount(account: AccountSettings | null | undefined) {
  if (!account) return null
  return { ...account, ...(account.OAUTH ? { OAUTH: { ...account.OAUTH } } : {}) }
}
function cloneSettings(settings: UserSettingsFile) {
  return { ...settings, accounts: Array.isArray(settings.accounts) ? settings.accounts.map((account) => cloneAccount(account)!).filter(Boolean) : [] }
}
function hasLegacyAccount(raw: UserSettingsFile) {
  return Boolean(text(raw.AGENT) || text(raw.PROVIDER) || text(raw.API_KEY) || text(raw.BASE_URL))
}
function readOAuth(provider: string, value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const source = value as Record<string, unknown>
  const oauth: VendorOAuthState = { provider }
  for (const key of OAUTH_KEYS) {
    const next = text(source[key])
    if (next) oauth[key] = next
  }
  return Object.keys(oauth).length > 1 ? oauth : undefined
}

export function accountDisplayName(input: Partial<AccountSettings>, index: number) {
  return text(input.name) || [text(input.PROVIDER), text(input.AGENT)].filter(Boolean).join(" / ") || `账号 ${index + 1}`
}

export class AccountsManager {
  accounts: AccountSettings[] = []
  currentAccountId: string | null = null
  readonly fallbackModel: string
  readonly fallbackBaseUrl?: string

  constructor(input: {
    accounts?: Array<Partial<AccountSettings>> | null
    currentAccountId?: string | null
    hasExplicitCurrentAccount?: boolean
    fallbackModel?: string
    fallbackBaseUrl?: string
  } = {}) {
    this.fallbackModel = text(input.fallbackModel) || DEFAULT_MODEL
    this.fallbackBaseUrl = maybe(input.fallbackBaseUrl)
    this.reset(input)
  }
  static getForcedProviderForAgent(agent: unknown) {
    const value = text(agent)
    return FORCED_PROVIDER_BY_AGENT[value as keyof typeof FORCED_PROVIDER_BY_AGENT] ?? null
  }
  static getProviderOptionsForAgent(agent: unknown): string[] {
    const forced = AccountsManager.getForcedProviderForAgent(agent)
    return forced ? [forced] : [...DEFAULT_PROVIDER_OPTIONS]
  }
  static resolveProviderForAgent(agent: unknown, provider: unknown) {
    return AccountsManager.getForcedProviderForAgent(agent) ?? (text(provider) || DEFAULT_PROVIDER)
  }
  static getDefaultModelForProvider(provider: unknown) { return getVendorDefaultModel(text(provider) || DEFAULT_PROVIDER) ?? DEFAULT_MODEL }
  static getProviderBrandVendor(provider: unknown) { return getVendorBrandVendor(text(provider) || DEFAULT_PROVIDER) ?? DEFAULT_PROVIDER }
  static getDefaultBaseUrlForProvider(provider: unknown) { return text(provider) ? (getVendorDefaultBaseUrl(text(provider)) ?? "") : DEFAULT_BASE_URL }
  static getOAuthUiForProvider(provider: unknown): VendorOAuthUiConfig | undefined { return getVendorOAuthUi(text(provider) || DEFAULT_PROVIDER) }
  static createUniqueName(baseName: unknown, accounts: Array<Partial<AccountSettings>>) {
    const base = text(baseName) || "账号"
    const used = new Set(accounts.map((account) => accountNameKey(account.name)).filter(Boolean))
    if (!used.has(base.toLocaleLowerCase())) return base
    let suffix = 2
    while (used.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1
    return `${base} ${suffix}`
  }
  static getDuplicateName(accounts: Array<Partial<AccountSettings>>) {
    const seen = new Set<string>()
    for (const account of accounts) {
      const key = accountNameKey(account.name)
      if (!key) continue
      if (seen.has(key)) return text(account.name) || null
      seen.add(key)
    }
    return null
  }
  static materializeAccount(input: Partial<AccountSettings>, index: number, fallbackModel = DEFAULT_MODEL, fallbackBaseUrl?: string): AccountSettings {
    const AGENT = text(input.AGENT) || DEFAULT_AGENT
    const PROVIDER = AccountsManager.resolveProviderForAgent(AGENT, input.PROVIDER)
    const account: AccountSettings = {
      id: text(input.id) || createAccountId(),
      name: text(input.name) || accountDisplayName({ AGENT, PROVIDER }, index),
      AGENT,
      PROVIDER,
      MODEL: text(input.MODEL) || text(fallbackModel) || AccountsManager.getDefaultModelForProvider(PROVIDER),
      REASONING_EFFORT: reasoningEffort(input.REASONING_EFFORT),
      API_KEY: text(input.API_KEY),
    }
    const SERVICE_TIER = serviceTier(input.SERVICE_TIER)
    const BASE_URL = text(input.BASE_URL) || text(fallbackBaseUrl) || AccountsManager.getDefaultBaseUrlForProvider(PROVIDER)
    const OAUTH = readOAuth(PROVIDER, input.OAUTH)
    if (SERVICE_TIER) account.SERVICE_TIER = SERVICE_TIER
    if (BASE_URL) account.BASE_URL = BASE_URL
    if (OAUTH) account.OAUTH = OAUTH
    return account
  }
  static createAccount(existingAccounts: Array<Partial<AccountSettings>>, input: Partial<AccountSettings> = {}) {
    const AGENT = text(input.AGENT) || DEFAULT_AGENT
    const PROVIDER = AccountsManager.resolveProviderForAgent(AGENT, input.PROVIDER)
    const SERVICE_TIER = serviceTier(input.SERVICE_TIER)
    return AccountsManager.materializeAccount({
      id: text(input.id) || createAccountId(),
      name: text(input.name) || AccountsManager.createUniqueName("账号", existingAccounts),
      AGENT,
      PROVIDER,
      MODEL: text(input.MODEL) || AccountsManager.getDefaultModelForProvider(PROVIDER),
      REASONING_EFFORT: text(input.REASONING_EFFORT) || DEFAULT_REASONING_EFFORT,
      ...(SERVICE_TIER ? { SERVICE_TIER } : {}),
      API_KEY: text(input.API_KEY),
      BASE_URL: text(input.BASE_URL) || AccountsManager.getDefaultBaseUrlForProvider(PROVIDER),
      OAUTH: input.OAUTH,
    }, existingAccounts.length)
  }
  reset(input: {
    accounts?: Array<Partial<AccountSettings>> | null
    currentAccountId?: string | null
    hasExplicitCurrentAccount?: boolean
  } = {}) {
    const seen = new Set<string>()
    this.accounts = (Array.isArray(input.accounts) ? input.accounts : [])
      .filter((item): item is Partial<AccountSettings> => Boolean(item) && typeof item === "object")
      .map((item, index) => AccountsManager.materializeAccount(item, index, this.fallbackModel, this.fallbackBaseUrl))
      .map((account, index) => {
        let id = account.id
        while (seen.has(id)) id = createAccountId()
        seen.add(id)
        return {
          ...account,
          id,
          name: account.name || accountDisplayName(account, index),
        }
      })
    this.currentAccountId = (
      typeof input.currentAccountId === "string" && this.accounts.some((account) => account.id === input.currentAccountId)
        ? input.currentAccountId
        : input.hasExplicitCurrentAccount
          ? null
          : (this.accounts[0]?.id ?? null)
    )
    return this
  }
  toJSON() {
    return this.accounts.map((account) => cloneAccount(account)!).filter(Boolean)
  }
  getCurrentAccount() {
    return cloneAccount(this.accounts.find((account) => account.id === this.currentAccountId) ?? null)
  }
  create(input: Partial<AccountSettings> = {}) {
    return AccountsManager.createAccount(this.accounts, input)
  }
  getDuplicateName(extraAccounts: Array<Partial<AccountSettings>> = []) {
    return AccountsManager.getDuplicateName([...this.accounts, ...extraAccounts])
  }
  setAccounts(accounts: Array<Partial<AccountSettings>>, currentAccountId: string | null = this.currentAccountId) {
    return this.reset({ accounts, currentAccountId, hasExplicitCurrentAccount: true })
  }
  setCurrentAccountId(currentAccountId: string | null) {
    return this.reset({ accounts: this.accounts, currentAccountId, hasExplicitCurrentAccount: true })
  }
  resolveRuntime(userSettings: UserSettingsFile): RuntimeSettings {
    const currentAccount = this.getCurrentAccount()
    return {
      agent: currentAccount?.AGENT ?? DEFAULT_AGENT,
      provider: currentAccount?.PROVIDER ?? DEFAULT_PROVIDER,
      model: currentAccount?.MODEL ?? AccountsManager.getDefaultModelForProvider(currentAccount?.PROVIDER),
      reasoningEffort: currentAccount?.REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT,
      serviceTier: currentAccount?.SERVICE_TIER,
      apiKey: currentAccount?.API_KEY ?? "",
      baseUrl: currentAccount?.BASE_URL ?? AccountsManager.getDefaultBaseUrlForProvider(currentAccount?.PROVIDER),
      currentAccount,
      userSettings: cloneSettings(userSettings),
    }
  }
}
export class SettingsModel {
  private data: UserSettingsFile = {}
  private accountsManager: AccountsManager = new AccountsManager()
  constructor(raw: unknown = {}) {
    this.reset(raw)
  }
  private reset(raw: unknown) {
    const input = raw && typeof raw === "object" ? { ...(raw as Record<string, any>) } as UserSettingsFile : {}
    const rawAccounts = Array.isArray(input.accounts)
      ? input.accounts as Array<Partial<AccountSettings>>
      : hasLegacyAccount(input)
        ? [{
          id: "default",
          name: "默认账号",
          AGENT: input.AGENT,
          PROVIDER: input.PROVIDER,
          MODEL: input.MODEL,
          REASONING_EFFORT: input.REASONING_EFFORT,
          SERVICE_TIER: input.SERVICE_TIER,
          API_KEY: input.API_KEY,
          BASE_URL: input.BASE_URL,
        }]
        : []

    this.accountsManager = new AccountsManager({
      accounts: rawAccounts,
      currentAccountId: input.currentAccountId,
      hasExplicitCurrentAccount: Object.prototype.hasOwnProperty.call(input, "currentAccountId"),
      fallbackModel: text(input.MODEL) || DEFAULT_MODEL,
      fallbackBaseUrl: maybe(input.BASE_URL),
    })

    const {
      AGENT: _AGENT,
      PROVIDER: _PROVIDER,
      API_KEY: _API_KEY,
      BASE_URL: _BASE_URL,
      MODEL: _MODEL,
      REASONING_EFFORT: _REASONING_EFFORT,
      SERVICE_TIER: _SERVICE_TIER,
      ...rest
    } = input
    this.data = {
      ...rest,
      accounts: this.accountsManager.toJSON(),
      currentAccountId: this.accountsManager.currentAccountId,
    }
  }
  toJSON(): UserSettingsFile {
    return cloneSettings(this.data)
  }
  get accounts(): AccountSettings[] {
    return this.accountsManager.toJSON()
  }
  get currentAccountId(): string | null {
    return this.accountsManager.currentAccountId
  }
  getCurrentAccount() { return this.accountsManager.getCurrentAccount() }
  resolveRuntime() { return this.accountsManager.resolveRuntime(this.toJSON()) }
  update(patch: Partial<UserSettingsFile>) {
    this.reset({ ...this.data, ...patch })
    return this
  }
  replaceAccounts(accounts: Partial<AccountSettings>[], currentAccountId: string | null = this.currentAccountId) {
    this.reset({ ...this.data, accounts, currentAccountId })
    return this
  }
  setCurrentAccountId(currentAccountId: string | null) {
    this.reset({ ...this.data, currentAccountId })
    return this
  }
}
