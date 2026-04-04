import type { VendorProvider } from "./types"

const ANTIGRAVITY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const ANTIGRAVITY_OAUTH_CLIENT_SECRET = "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"
const ANTIGRAVITY_OAUTH_SCOPES = "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/experimentsandconfigs"

export const antigravityVendor: VendorProvider = {
  id: "antigravity",
  oauth: {
    start({ redirectUri, state }) {
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: ANTIGRAVITY_OAUTH_SCOPES,
        access_type: "offline",
        prompt: "consent",
        state,
      })}`
      return { authUrl }
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
          client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      })

      const text = await res.text()
      let data: Record<string, any> = {}
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error(text || `OAuth token exchange failed (${res.status})`)
        }
      }

      if (!res.ok) {
        throw new Error(String(data.error_description || data.error || text || `OAuth token exchange failed (${res.status})`))
      }

      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token.trim() : ""
      if (!refreshToken) {
        throw new Error(
          "OAuth completed but no refresh token was returned. Try revoking AnyCode access in Google Account permissions and sign in again.",
        )
      }

      return { refreshToken }
    },
  },
}
