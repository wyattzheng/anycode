#!/usr/bin/env node
/**
 * OAuth helper — obtains a Google refresh_token for Antigravity Agent.
 *
 * Usage:
 *   node packages/antigravity-agent/scripts/get-token.mjs
 *
 * This script:
 * 1. Opens browser for Google OAuth consent
 * 2. Receives the callback with authorization code
 * 3. Exchanges code for access_token + refresh_token
 * 4. Prints the refresh_token for use as API_KEY
 */
import http from "node:http"
import https from "node:https"
import { execSync } from "node:child_process"
import { URL, URLSearchParams } from "node:url"

const CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const CLIENT_SECRET = "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"
const SCOPES =
  "openid email profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/experimentsandconfigs"
const PORT = 19877
const REDIRECT_URI = `http://localhost:${PORT}/oauth-callback`

function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    })
    const req = https.request(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
      (res) => {
        let d = ""
        res.on("data", (c) => (d += c))
        res.on("end", () => {
          try {
            resolve(JSON.parse(d))
          } catch {
            reject(new Error(d))
          }
        })
      },
    )
    req.on("error", reject)
    req.write(params.toString())
    req.end()
  })
}

async function main() {
  console.log("═".repeat(50))
  console.log("  🔐 Antigravity Agent — Get Refresh Token")
  console.log("═".repeat(50))

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(
    {
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
    },
  )}`

  const code = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${PORT}`)
      if (u.pathname === "/oauth-callback" && u.searchParams.get("code")) {
        res.writeHead(200, { "Content-Type": "text/html" })
        res.end(
          "<h1>✅ Done! Return to terminal.</h1><script>window.close()</script>",
        )
        srv.close()
        resolve(u.searchParams.get("code"))
      }
    })
    srv.listen(PORT, () => {
      console.log("\n🌐 Opening browser for Google OAuth...")
      console.log("   (If browser doesn't open, visit this URL manually)\n")
      try {
        execSync(`open "${authUrl}"`)
      } catch {
        console.log(authUrl)
      }
    })
  })

  console.log("\n📡 Exchanging code for tokens...")
  const tokens = await exchangeCode(code)

  if (tokens.error) {
    console.error(`\n❌ Error: ${tokens.error_description || tokens.error}`)
    process.exit(1)
  }

  if (!tokens.refresh_token) {
    console.error(
      "\n❌ No refresh_token received. " +
        "Try revoking access at https://myaccount.google.com/permissions and trying again.",
    )
    process.exit(1)
  }

  console.log("\n" + "═".repeat(50))
  console.log("  ✅ Success! Your refresh token:")
  console.log("═".repeat(50))
  console.log(`\n${tokens.refresh_token}\n`)
  console.log("Configure it as API_KEY in your AnyCode settings.")
  console.log(
    "The token is long-lived and will be used to obtain fresh access tokens automatically.\n",
  )

  process.exit(0)
}

main().catch((e) => {
  console.error("💥", e.message)
  process.exit(1)
})
