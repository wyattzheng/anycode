import fs from "fs"
import http from "http"
import https from "https"
import { URL } from "url"
import type { PreviewProvider } from "@any-code/agent"

export interface PreviewServerConfig {
  previewPort: number
  tlsCert?: string
  tlsKey?: string
}

export interface PreviewServerRuntime {
  previewProviders: Map<string, NodePreviewProvider>
  previewTarget: string | null
  setPreviewTarget(sessionId: string, forwardedLocalUrl: string): string | null
  getSession(id: string): { state: { setPreviewPort(port: number | null): void } } | undefined
}

function createHttpServer(cfg: PreviewServerConfig, handler: http.RequestListener): http.Server {
  if (cfg.tlsCert && cfg.tlsKey) {
    return https.createServer({
      cert: fs.readFileSync(cfg.tlsCert),
      key: fs.readFileSync(cfg.tlsKey),
    }, handler)
  }
  return http.createServer(handler)
}

export class NodePreviewProvider implements PreviewProvider {
  constructor(
    private readonly server: PreviewServerRuntime,
    private readonly cfg: PreviewServerConfig,
    public readonly sessionId: string,
  ) {}

  setPreviewTarget(forwardedLocalUrl: string): void {
    const previewTarget = this.server.setPreviewTarget(this.sessionId, forwardedLocalUrl)
    console.log(`🔗  Preview proxy: :${this.cfg.previewPort} → ${previewTarget} (session ${this.sessionId})`)
    this.server.getSession(this.sessionId)?.state.setPreviewPort(this.cfg.previewPort)
  }
}

export function getOrCreatePreviewProvider(server: PreviewServerRuntime, cfg: PreviewServerConfig, sessionId: string): NodePreviewProvider {
  let pp = server.previewProviders.get(sessionId)
  if (!pp) {
    pp = new NodePreviewProvider(server, cfg, sessionId)
    server.previewProviders.set(sessionId, pp)
  }
  return pp
}

export function createPreviewServer(server: PreviewServerRuntime, cfg: PreviewServerConfig): http.Server {
  const previewServer = createHttpServer(cfg, (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "*")
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return }

    if (!server.previewTarget) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end("No preview target configured")
      return
    }

    try {
      const targetUrl = server.previewTarget + (req.url || "/")
      const parsed = new URL(targetUrl)
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: { ...req.headers, host: parsed.host },
      }

      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", () => {
        const body = Buffer.concat(chunks)
        const RETRY_DELAY = 2000

        const attempt = () => {
          const proxyReq = http.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
            proxyRes.pipe(res)
          })

          proxyReq.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ECONNREFUSED" && !res.destroyed) {
              setTimeout(attempt, RETRY_DELAY)
            } else {
              if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
              res.end(`Preview proxy error: ${err.message}`)
            }
          })

          proxyReq.end(body)
        }
        attempt()
      })
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "text/plain" })
      res.end(`Invalid proxy target: ${err.message}`)
    }
  })

  previewServer.on("upgrade", (req, socket, head) => {
    if (!server.previewTarget) {
      socket.destroy()
      return
    }

    try {
      const parsed = new URL(server.previewTarget)
      const targetWs = `ws://${parsed.hostname}:${parsed.port}${req.url || "/"}`
      const wsTarget = new URL(targetWs)

      const options: http.RequestOptions = {
        hostname: wsTarget.hostname,
        port: wsTarget.port,
        path: wsTarget.pathname + wsTarget.search,
        method: "GET",
        headers: { ...req.headers, host: wsTarget.host },
      }

      const proxyReq = http.request(options)

      proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          Object.entries(_proxyRes.headers)
            .filter(([k]) => !["upgrade", "connection"].includes(k.toLowerCase()))
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n"
        )
        if (proxyHead.length > 0) socket.write(proxyHead)
        proxySocket.pipe(socket)
        socket.pipe(proxySocket)
      })

      proxyReq.on("error", () => socket.destroy())
      socket.on("error", () => proxyReq.destroy())

      proxyReq.end()
    } catch {
      socket.destroy()
    }
  })

  return previewServer
}
