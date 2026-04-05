import type http from "http"
import { AccountsManager, SettingsModel, type UserSettingsFile } from "@any-code/settings"
import { VendorRegistry, type VendorOAuthState } from "@any-code/provider"
import { AccountQuotaManager } from "./quota"
import { API_ERROR_CODES, createApiError } from "./errors"
import type { AnyCodeServer, ServerConfig } from "./index"

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const ACCOUNT_QUOTA_CACHE_TTL_MS = 10 * 1000
const text = (value: unknown) => typeof value === "string" ? value.trim() : ""

export interface OAuthSessionRecord {
  id: string
  provider: string
  state: string
  redirectUri: string
  createdAt: number
  status: "pending" | "success" | "error"
  apiKey?: string
  oauth?: VendorOAuthState | null
  exchangeData?: Record<string, string>
  error?: string
}

function getFirstHeaderValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return text(value[0]) || undefined
  if (typeof value !== "string") return undefined
  return text(value.split(",")[0]) || undefined
}

function readForwardedToken(value: string | undefined) {
  return text(value?.replace(/^"|"$/g, "")) || undefined
}

function readPublicBaseUrl(value: unknown) {
  const baseUrl = text(value)
  if (!baseUrl) return undefined
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
    if (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]" || url.hostname === "0.0.0.0") {
      url.hostname = "localhost"
    }
    return url.origin + url.pathname.replace(/\/+$/, "")
  } catch {
    return undefined
  }
}

function getForwardedBaseUrl(req: http.IncomingMessage, cfg: ServerConfig) {
  const forwarded = text(req.headers.forwarded) || undefined
  if (forwarded) {
    const first = forwarded.split(",")[0] ?? ""
    const protoMatch = first.match(/(?:^|;)\s*proto=([^;]+)/i)
    const hostMatch = first.match(/(?:^|;)\s*host=([^;]+)/i)
    const proto = readForwardedToken(protoMatch?.[1])?.replace(/:$/, "")
    const host = readForwardedToken(hostMatch?.[1])
    if (host && (proto === "http" || proto === "https")) return `${proto}://${host}`
  }

  const forwardedHost = getFirstHeaderValue(req.headers["x-forwarded-host"])
  if (!forwardedHost) return undefined

  const forwardedProto = getFirstHeaderValue(req.headers["x-forwarded-proto"])?.replace(/:$/, "")
  const forwardedPort = getFirstHeaderValue(req.headers["x-forwarded-port"])
  const protocol = forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : (cfg.tlsCert ? "https" : "http")
  const host = forwardedHost.includes(":") || !forwardedPort ? forwardedHost : `${forwardedHost}:${forwardedPort}`
  return `${protocol}://${host}`
}

function getRequestBaseUrl(req: http.IncomingMessage, cfg: ServerConfig) {
  const fromOrigin = readPublicBaseUrl(req.headers.origin)
  if (fromOrigin) return fromOrigin

  const forwardedBaseUrl = getForwardedBaseUrl(req, cfg)
  if (forwardedBaseUrl) return forwardedBaseUrl

  const referer = text(req.headers.referer)
  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      /* ignore */
    }
  }

  const host = text(req.headers.host) || `localhost:${cfg.port}`
  return `${cfg.tlsCert ? "https" : "http"}://${host}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function oauthCallbackHtml(title: string, message: string, isError = false) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #0d1117;
    color: #e6edf3;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    padding: 24px;
  }
  .card {
    width: min(420px, 100%);
    padding: 24px;
    border-radius: 16px;
    background: #161b22;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 24px 60px rgba(0,0,0,0.35);
  }
  h1 {
    margin: 0 0 10px;
    font-size: 20px;
    color: ${isError ? "#ff938a" : "#9be9a8"};
  }
  p { margin: 0; color: #c9d1d9; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
  <script>setTimeout(() => window.close(), 1200)</script>
</body>
</html>`
}

function getProviderOAuth(provider: string) {
  const oauth = VendorRegistry.getVendorProvider({ id: provider }).getOAuth()
  if (!oauth) {
    throw createApiError(`OAuth is not supported for provider "${provider}"`, API_ERROR_CODES.OAUTH_PROVIDER_UNSUPPORTED)
  }
  return oauth
}

export class ServerAccountsManager {
  readonly oauthSessions = new Map<string, OAuthSessionRecord>()
  readonly oauthStateIndex = new Map<string, string>()
  readonly accountQuota: AccountQuotaManager

  constructor(private readonly server: AnyCodeServer) {
    this.accountQuota = new AccountQuotaManager(ACCOUNT_QUOTA_CACHE_TTL_MS, {
      persistCredentials: (accountId, credentials) => this.persistAccountCredentials(accountId, credentials),
    })
  }

  readUserSettingsFile(): UserSettingsFile {
    return this.server.settingsStore.read().toJSON()
  }

  writeUserSettingsFile(settings: UserSettingsFile) {
    const saved = this.server.settingsStore.write(settings).toJSON()
    this.accountQuota.clear()
    return saved
  }

  applySettingsToConfig(settings: UserSettingsFile) {
    const runtime = new SettingsModel(settings).resolveRuntime()
    this.server.cfg.userSettings = runtime.userSettings
    this.server.cfg.agent = runtime.agent
    this.server.cfg.provider = runtime.provider
    this.server.cfg.apiKey = runtime.apiKey
    this.server.cfg.baseUrl = runtime.baseUrl
    this.server.cfg.model = runtime.model
    this.server.cfg.reasoningEffort = runtime.reasoningEffort
    this.server.cfg.serviceTier = runtime.serviceTier
  }

  persistCurrentAccountApiKey(apiKey: string) {
    const settings = new SettingsModel(this.readUserSettingsFile())
    const currentAccount = settings.getCurrentAccount()
    if (!currentAccount) return
    this.persistAccountCredentials(currentAccount.id, { apiKey })
  }

  persistCurrentAccountCredentials(credentials: { apiKey?: string; oauth?: VendorOAuthState | null }) {
    const settings = new SettingsModel(this.readUserSettingsFile())
    const currentAccount = settings.getCurrentAccount()
    if (!currentAccount) return
    this.persistAccountCredentials(currentAccount.id, credentials)
  }

  persistAccountCredentials(accountId: string, credentials: { apiKey?: string; oauth?: VendorOAuthState | null }) {
    const hasApiKey = Object.prototype.hasOwnProperty.call(credentials, "apiKey")
    const hasOAuth = Object.prototype.hasOwnProperty.call(credentials, "oauth")
    const nextApiKey = typeof credentials.apiKey === "string" ? text(credentials.apiKey) : undefined
    const nextOAuth = hasOAuth ? (credentials.oauth ?? undefined) : undefined

    const settings = new SettingsModel(this.readUserSettingsFile())
    const targetAccount = settings.accounts.find((account) => account.id === accountId)
    if (!targetAccount) return

    const apiKeyUnchanged = !hasApiKey || targetAccount.API_KEY === (nextApiKey ?? "")
    const oauthUnchanged = !hasOAuth || JSON.stringify(targetAccount.OAUTH ?? null) === JSON.stringify(nextOAuth ?? null)
    if (apiKeyUnchanged && oauthUnchanged) return

    const accounts = settings.accounts.map((account) => (
      account.id === accountId
        ? {
          ...account,
          ...(hasApiKey ? { API_KEY: nextApiKey ?? "" } : {}),
          ...(hasOAuth ? (nextOAuth ? { OAUTH: nextOAuth } : { OAUTH: undefined }) : {}),
        }
        : account
    ))
    const saved = this.writeUserSettingsFile(settings.replaceAccounts(accounts, settings.currentAccountId).toJSON())
    if (saved.currentAccountId === accountId) this.applySettingsToConfig(saved)
  }

  async resolveRuntimeConfig(cfg: ServerConfig) {
    const currentAccount = new SettingsModel(cfg.userSettings).getCurrentAccount()
    const resolved = await VendorRegistry.getVendorProvider({ id: cfg.provider }).resolveApiKey({
      apiKey: cfg.apiKey,
      agent: cfg.agent,
      oauth: currentAccount?.OAUTH ?? null,
    }).catch((): { apiKey: string, persistedApiKey?: string, persistedOAuth?: VendorOAuthState | null } => ({ apiKey: cfg.apiKey }))

    if (resolved.persistedApiKey || resolved.persistedOAuth) {
      this.persistCurrentAccountCredentials({
        ...(resolved.persistedApiKey && resolved.persistedApiKey !== cfg.apiKey ? { apiKey: resolved.persistedApiKey } : {}),
        ...(resolved.persistedOAuth ? { oauth: resolved.persistedOAuth } : {}),
      })
    }

    return resolved.apiKey === cfg.apiKey ? cfg : { ...cfg, apiKey: resolved.apiKey }
  }

  async resolveProviderApiKey(provider: string, apiKey: string, agent?: string, oauth?: VendorOAuthState | null) {
    const providerId = text(provider)
    const nextApiKey = text(apiKey)
    if (!providerId) throw createApiError("Provider is required", API_ERROR_CODES.INVALID_REQUEST)
    if (!nextApiKey) throw createApiError("API key is required", API_ERROR_CODES.INVALID_REQUEST)

    const resolved = await VendorRegistry.getVendorProvider({ id: providerId }).resolveApiKey({
      apiKey: nextApiKey,
      agent: text(agent) || undefined,
      oauth: oauth ?? null,
    })

    return {
      apiKey: text(resolved.persistedApiKey) || nextApiKey,
      ...(resolved.persistedOAuth ? { oauth: resolved.persistedOAuth } : {}),
    }
  }

  async getAccountQuotas() {
    const settings = new SettingsModel(this.readUserSettingsFile())
    return { quotas: await this.accountQuota.getForAccounts(settings.accounts) }
  }

  cleanupOAuthSessions() {
    const now = Date.now()
    for (const [sessionId, session] of this.oauthSessions.entries()) {
      if (now - session.createdAt <= OAUTH_SESSION_TTL_MS) continue
      this.oauthSessions.delete(sessionId)
      this.oauthStateIndex.delete(session.state)
    }
  }

  startProviderOAuth(provider: string, req: http.IncomingMessage) {
    this.cleanupOAuthSessions()
    const oauth = getProviderOAuth(provider)
    const publicBaseUrl = getRequestBaseUrl(req, this.server.cfg)
    const id = crypto.randomUUID()
    const requestedState = crypto.randomUUID()
    const defaultRedirectUri = `${publicBaseUrl.replace(/\/+$/, "")}/auth/callback`
    const { authUrl, exchangeData, state, redirectUri, captureMode } = oauth.start({
      redirectUri: defaultRedirectUri,
      state: requestedState,
    })
    const effectiveState = state ?? requestedState
    const effectiveRedirectUri = redirectUri ?? defaultRedirectUri
    console.info("[AnyCode][OAuth]", JSON.stringify({ provider, redirectUri: effectiveRedirectUri, authUrl, captureMode: captureMode ?? "callback" }))

    this.oauthSessions.set(id, {
      id,
      provider,
      state: effectiveState,
      redirectUri: effectiveRedirectUri,
      createdAt: Date.now(),
      status: "pending",
      exchangeData,
    })
    this.oauthStateIndex.set(effectiveState, id)
    return { sessionId: id, authUrl, redirectUri: effectiveRedirectUri, captureMode: captureMode ?? "callback" }
  }

  getProviderOAuthSession(provider: string, sessionId: string) {
    this.cleanupOAuthSessions()
    const session = this.oauthSessions.get(sessionId)
    if (!session || session.provider !== provider) {
      throw createApiError("OAuth session not found", API_ERROR_CODES.OAUTH_SESSION_NOT_FOUND)
    }
    return {
      sessionId: session.id,
      status: session.status,
      apiKey: session.apiKey,
      ...(session.oauth ? { oauth: session.oauth } : {}),
      error: session.error,
    }
  }

  cancelProviderOAuthSession(provider: string, sessionId: string) {
    this.cleanupOAuthSessions()
    const session = this.oauthSessions.get(sessionId)
    if (!session || session.provider !== provider) {
      throw createApiError("OAuth session not found", API_ERROR_CODES.OAUTH_SESSION_NOT_FOUND)
    }
    this.oauthSessions.delete(sessionId)
    this.oauthStateIndex.delete(session.state)
    return { ok: true }
  }

  async completeProviderOAuth(provider: string, params: URLSearchParams) {
    this.cleanupOAuthSessions()
    const state = text(params.get("state"))
    if (!state) return oauthCallbackHtml("登录失败", "OAuth state is missing.", true)

    const sessionId = this.oauthStateIndex.get(state)
    const session = sessionId ? this.oauthSessions.get(sessionId) : undefined
    if (!session || session.provider !== provider) {
      return oauthCallbackHtml("登录已失效", "This OAuth session was not found or has expired.", true)
    }

    const deniedError = text(params.get("error"))
    if (deniedError) {
      const description = text(params.get("error_description")) || deniedError
      session.status = "error"
      session.error = description
      return oauthCallbackHtml("登录未完成", description, true)
    }

    if (session.status === "success" && session.apiKey) {
      return oauthCallbackHtml("登录成功", "You can return to AnyCode now.")
    }

    const code = text(params.get("code"))
    if (!code) {
      session.status = "error"
      session.error = "Authorization code is missing."
      return oauthCallbackHtml("登录失败", session.error, true)
    }

    try {
      const oauth = getProviderOAuth(provider)
      const tokens = await oauth.exchangeCode({
        code,
        state,
        redirectUri: session.redirectUri,
        exchangeData: session.exchangeData,
      })
      session.status = "success"
      session.apiKey = tokens.apiKey
      session.oauth = tokens.oauth
      session.error = undefined
      return oauthCallbackHtml("登录成功", "Token has been captured. Return to AnyCode and continue.")
    } catch (error: any) {
      session.status = "error"
      session.error = error instanceof Error ? error.message : "OAuth exchange failed."
      return oauthCallbackHtml("登录失败", session.error, true)
    }
  }

  async completeProviderOAuthFromState(params: URLSearchParams) {
    this.cleanupOAuthSessions()
    const state = text(params.get("state"))
    if (!state) return oauthCallbackHtml("登录失败", "OAuth state is missing.", true)

    const sessionId = this.oauthStateIndex.get(state)
    const session = sessionId ? this.oauthSessions.get(sessionId) : undefined
    if (!session) {
      return oauthCallbackHtml("登录已失效", "This OAuth session was not found or has expired.", true)
    }
    return this.completeProviderOAuth(session.provider, params)
  }
}
