import http from "http"
import https from "https"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { AnyCodeServer, ServerConfig } from "./index"
import { API_ERROR_CODES, getErrorCode } from "./errors"
import { AccountsManager, SettingsModel } from "@any-code/settings"
import type { VendorOAuthState } from "@any-code/provider"
import { adminHTML } from "./admin"
import { computeFileDiff, getGitChanges, listDir } from "./filesystem"

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".css": "text/css", ".js": "application/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf",
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : ""

function serveStatic(cfg: ServerConfig, req: http.IncomingMessage, res: http.ServerResponse) {
  const filePath = path.join(cfg.appDist, req.url || "/")
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false
  const ext = path.extname(filePath)
  const data = fs.readFileSync(filePath)
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Content-Length": data.length,
  })
  res.end(data)
  return true
}

function serveAppIndex(cfg: ServerConfig, res: http.ServerResponse) {
  const indexPath = path.join(cfg.appDist, "index.html")
  if (!fs.existsSync(indexPath)) return false
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
  res.end(fs.readFileSync(indexPath, "utf-8"))
  return true
}

function createServer(cfg: ServerConfig, handler: http.RequestListener) {
  if (cfg.tlsCert && cfg.tlsKey) {
    return https.createServer({
      cert: fs.readFileSync(cfg.tlsCert),
      key: fs.readFileSync(cfg.tlsKey),
    }, handler)
  }
  return http.createServer(handler)
}

async function readJsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return {}
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  if (res.writableEnded) return
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function sendErrorJson(res: http.ServerResponse, status: number, error: unknown, fallbackMessage = "Request failed") {
  const message = error instanceof Error ? error.message : fallbackMessage
  const code = getErrorCode(error)
  sendJson(res, status, code ? { error: message, code } : { error: message })
}

export function resolveAppDist() {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "app")
  if (fs.existsSync(path.join(bundled, "index.html"))) return bundled

  try {
    const resolved = path.dirname(fileURLToPath(import.meta.resolve("@any-code/app/index.html")))
    if (fs.existsSync(path.join(resolved, "index.html"))) return resolved
  } catch {
    /* ignore */
  }

  return bundled
}

export function createMainServer(server: AnyCodeServer, cfg: ServerConfig) {
  return createServer(cfg, async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    if (req.method === "GET" && !req.url?.startsWith("/api/") && !req.url?.startsWith("/admin") && !req.url?.startsWith("/auth/")) {
      if (serveStatic(cfg, req, res)) return
      if (serveAppIndex(cfg, res)) return
    }

    if (req.method === "GET" && req.url === "/api/settings") {
      const settings = server.accounts.readUserSettingsFile()
      sendJson(res, 200, {
        accounts: settings.accounts ?? [],
        currentAccountId: settings.currentAccountId ?? null,
      })
      return
    }

    if (req.method === "GET" && req.url === "/api/account-quotas") {
      try {
        sendJson(res, 200, await server.accounts.getAccountQuotas())
      } catch (error) {
        sendErrorJson(res, 500, error, "Failed to load account quotas")
      }
      return
    }

    const oauthStartMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/start$/)
    if (req.method === "POST" && oauthStartMatch) {
      try {
        sendJson(res, 200, server.accounts.startProviderOAuth(oauthStartMatch[1], req))
      } catch (error) {
        sendErrorJson(res, 400, error, "Failed to start OAuth")
      }
      return
    }

    const providerApiKeyResolveMatch = req.url?.match(/^\/api\/providers\/([^/?]+)\/api-key\/resolve$/)
    if (req.method === "POST" && providerApiKeyResolveMatch) {
      const body = await readJsonBody(req)
      try {
        const result = await server.accounts.resolveProviderApiKey(
          providerApiKeyResolveMatch[1],
          String(body.apiKey ?? ""),
          text(body.agent) || undefined,
          body.oauth && typeof body.oauth === "object" ? body.oauth as VendorOAuthState : null,
        )
        sendJson(res, 200, result)
      } catch (error) {
        sendErrorJson(res, 400, error, "Failed to resolve provider API key")
      }
      return
    }

    const oauthSessionMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/sessions\/([^/?]+)$/)
    if (req.method === "GET" && oauthSessionMatch) {
      try {
        sendJson(res, 200, server.accounts.getProviderOAuthSession(oauthSessionMatch[1], oauthSessionMatch[2]))
      } catch (error) {
        sendErrorJson(res, 404, error, "OAuth session not found")
      }
      return
    }

    if (req.method === "DELETE" && oauthSessionMatch) {
      try {
        sendJson(res, 200, server.accounts.cancelProviderOAuthSession(oauthSessionMatch[1], oauthSessionMatch[2]))
      } catch (error) {
        sendErrorJson(res, 404, error, "OAuth session not found")
      }
      return
    }

    const oauthCallbackMatch = req.url?.match(/^\/api\/oauth\/([^/?]+)\/callback(?:\?|$)/)
    if (req.method === "GET" && oauthCallbackMatch) {
      const url = new URL(req.url!, `${cfg.tlsCert ? "https" : "http"}://localhost:${cfg.port}`)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(await server.accounts.completeProviderOAuth(oauthCallbackMatch[1], url.searchParams))
      return
    }

    if (req.method === "GET" && req.url?.match(/^\/auth\/callback(?:\?|$)/)) {
      const url = new URL(req.url!, `${cfg.tlsCert ? "https" : "http"}://localhost:${cfg.port}`)
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(await server.accounts.completeProviderOAuthFromState(url.searchParams))
      return
    }

    if (req.method === "POST" && req.url === "/api/settings") {
      const previous = server.accounts.readUserSettingsFile()
      const body = await readJsonBody(req)
      const rawAccounts = Array.isArray(body.accounts) ? body.accounts : []
      const applyCurrentAccount = body.applyCurrentAccount === true
      const invalidAccount = rawAccounts.find((account: unknown) => (
        !account || typeof account !== "object"
        || !text((account as Record<string, unknown>).name)
        || !text((account as Record<string, unknown>).AGENT)
        || !text((account as Record<string, unknown>).PROVIDER)
        || !text((account as Record<string, unknown>).MODEL)
      ))
      if (invalidAccount) {
        sendJson(res, 400, {
          error: `Account "${text((invalidAccount as Record<string, unknown>).name) || text((invalidAccount as Record<string, unknown>).id) || "unknown"}" is incomplete`,
          code: API_ERROR_CODES.SETTINGS_ACCOUNT_INCOMPLETE,
        })
        return
      }

      const duplicateAccountName = AccountsManager.getDuplicateName(rawAccounts as Array<Record<string, unknown>>)
      if (duplicateAccountName) {
        sendJson(res, 400, {
          error: `Account name "${duplicateAccountName}" already exists`,
          code: API_ERROR_CODES.SETTINGS_ACCOUNT_NAME_DUPLICATE,
        })
        return
      }

      const next = new SettingsModel({
        ...previous,
        accounts: rawAccounts,
        currentAccountId: typeof body.currentAccountId === "string" ? body.currentAccountId : null,
      }).toJSON()

      if (!applyCurrentAccount) {
        const saved = server.accounts.writeUserSettingsFile(next)
        sendJson(res, 200, { ok: true, accounts: saved.accounts ?? [], currentAccountId: saved.currentAccountId ?? null })
        return
      }

      try {
        const saved = server.accounts.writeUserSettingsFile(next)
        server.accounts.applySettingsToConfig(saved)
        await server.sessionManager.applyAgentSwitchToSessions()
      } catch (error) {
        server.accounts.writeUserSettingsFile(previous)
        server.accounts.applySettingsToConfig(previous)
        try { await server.sessionManager.applyAgentSwitchToSessions() } catch (rollbackError) { console.error("⚠  Failed to roll back account switch:", rollbackError) }
        sendErrorJson(res, 500, error, "Failed to save settings")
        return
      }

      const saved = server.accounts.readUserSettingsFile()
      sendJson(res, 200, { ok: true, accounts: saved.accounts ?? [], currentAccountId: saved.currentAccountId ?? null })
      return
    }

    if (req.method === "POST" && req.url === "/api/sessions") {
      server.sessionManager.getOrCreateSession()
        .then((entry) => sendJson(res, 200, { id: entry.id, directory: entry.directory }))
        .catch((error) => sendErrorJson(res, 500, error))
      return
    }

    if (req.method === "GET" && req.url === "/api/sessions") {
      sendJson(res, 200, Array.from(server.sessions.values()).map((session) => ({
        id: session.id,
        directory: session.directory,
        createdAt: session.createdAt,
      })))
      return
    }

    if (req.method === "GET" && req.url?.startsWith("/api/windows")) {
      server.sessionManager.getAllWindows()
        .then((entries) => {
          const defaults = new Map(server.db.findMany("user_session", {}).map((row: any) => [row.session_id, row.is_default === 1]))
          sendJson(res, 200, entries.map((entry) => ({
            id: entry.id,
            title: entry.title || "",
            directory: entry.directory,
            createdAt: entry.createdAt,
            isDefault: defaults.get(entry.id) ?? false,
          })))
        })
        .catch((error) => sendErrorJson(res, 500, error))
      return
    }

    if (req.method === "POST" && req.url === "/api/windows") {
      server.sessionManager.createNewWindow(false)
        .then((entry) => sendJson(res, 200, { id: entry.id, directory: entry.directory, isDefault: false }))
        .catch((error) => sendErrorJson(res, 500, error))
      return
    }

    const windowDeleteMatch = req.url?.match(/^\/api\/windows\/([^/?]+)$/)
    if (req.method === "DELETE" && windowDeleteMatch) {
      server.sessionManager.deleteWindow(windowDeleteMatch[1])
        .then((ok) => sendJson(res, ok ? 200 : 400, ok ? { ok: true } : { error: "Cannot delete default window or window not found" }))
        .catch((error) => sendErrorJson(res, 500, error, "Failed to delete window"))
      return
    }

    const sessionMatch = req.url?.match(/^\/api\/sessions\/([^/?]+)(?:\/([a-z]+))?/)
    if ((req.method === "GET" || req.method === "POST") && sessionMatch) {
      const session = server.sessionManager.getSession(sessionMatch[1])
      if (!session) {
        sendJson(res, 404, { error: "Session not found" })
        return
      }

      const sub = sessionMatch[2]
      if (sub === "state") {
        const [topLevel, changes] = await Promise.all([
          session.directory ? listDir(session.directory) : Promise.resolve([]),
          session.directory ? getGitChanges(session.directory) : Promise.resolve([]),
        ])
        sendJson(res, 200, {
          directory: session.directory,
          topLevel,
          changes,
          previewPort: server.getPreviewPortForSession(session.id),
          previewBaseUrl: server.getPreviewBaseUrlForSession(session.id),
          previewPath: server.getPreviewPathForSession(session.id),
        })
        return
      }

      if (sub === "files" && req.method === "POST") {
        if (!session.directory) {
          sendJson(res, 200, { files: {} })
          return
        }
        const body = await readJsonBody(req)
        const paths = Array.isArray(body.paths) ? body.paths : []
        const withDiff = body.withDiff === true
        const root = path.resolve(session.directory)
        const files: Record<string, { content?: string; entries?: any[]; diff?: { added: number[]; removed: number[] }; error?: string }> = {}
        const BATCH_LIMIT = 1024 * 1024
        let totalRead = 0

        for (const filePath of paths) {
          const target = path.resolve(session.directory, filePath)
          if (!target.startsWith(root)) {
            files[filePath] = { error: "Forbidden" }
            continue
          }
          try {
            const stat = await fs.promises.stat(target)
            if (stat.isDirectory()) {
              files[filePath] = { entries: await listDir(target) }
              continue
            }
            if (totalRead >= BATCH_LIMIT || stat.size > 512 * 1024 || totalRead + stat.size > BATCH_LIMIT) {
              files[filePath] = { error: totalRead >= BATCH_LIMIT || totalRead + stat.size > BATCH_LIMIT ? "Batch limit reached" : "File too large" }
              continue
            }
            const content = await fs.promises.readFile(target, "utf-8")
            totalRead += stat.size
            files[filePath] = {
              content,
              ...(withDiff ? { diff: await computeFileDiff(session.directory, filePath, content) } : {}),
            }
          } catch {
            files[filePath] = { error: "读取失败" }
          }
        }

        sendJson(res, 200, { files })
        return
      }

      sendJson(res, 200, { id: session.id, directory: session.directory, createdAt: session.createdAt })
      return
    }

    if (req.method === "GET" && req.url === "/api/status") {
      const sessions = await Promise.all(Array.from(server.sessions.values()).map(async (session) => ({
        id: session.id,
        directory: session.directory,
        stats: await session.chatAgent.getUsage(),
        sessionId: session.chatAgent.sessionId,
        resumeToken: session.chatAgent.sessionId,
      })))
      sendJson(res, 200, { sessions })
      return
    }

    if (req.method === "GET" && req.url?.startsWith("/api/messages")) {
      const url = new URL(req.url, `http://localhost:${cfg.port}`)
      const messages = await server.sessionManager.getMessages(String(url.searchParams.get("sessionId") ?? ""))
      if (!messages) {
        sendJson(res, 404, { error: "Session not found" })
        return
      }
      sendJson(res, 200, messages)
      return
    }

    if (req.method === "GET" && req.url === "/admin") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(adminHTML(cfg))
      return
    }

    sendJson(res, 404, { error: "Not found" })
  })
}
