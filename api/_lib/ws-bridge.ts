import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer, WebSocket, type RawData } from "ws"
import { isAuthorized } from "./auth.js"
import { getOpenAIConfig } from "./upstream.js"
import { logger } from "./logger.js"

/**
 * WebSocket bridge for the OpenAI `wss://` transports (Codex 0.128+ streams the
 * Responses API over a WebSocket, and the Realtime API is WS-only). Serverless
 * platforms (Netlify/Vercel functions) cannot hold a WebSocket, so this attaches
 * ONLY to a long-running Node HTTP server — i.e. the self-hosted `pnpm start`
 * (dev-server.ts). It is never imported by the Netlify function or the Vercel
 * handler, so `ws` isn't bundled there.
 *
 * Flow: client `wss://<us>/v1/responses` → auth (Bearer / ?api_key) → open a
 * WebSocket to the resolved OpenAI upstream (`wss://…/v1/responses`) with the
 * upstream key injected → pipe frames both ways. The upstream MUST be
 * wss-capable — that means a direct OpenAI host (your own key). The Netlify AI
 * Gateway cannot do wss, so if the resolved base points there we refuse with a
 * clear close reason rather than hang.
 */

// Incoming client path → upstream subpath appended to the OpenAI base.
const WS_ROUTES: Record<string, string> = {
  "/v1/responses": "/responses",
  "/v1/realtime": "/realtime",
}

/** Headers worth forwarding from the client handshake to the upstream WS. */
const FORWARD_HEADERS = ["openai-beta", "openai-organization", "openai-project"]

export function attachWsBridge(server: Server): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url ?? "/", "http://localhost")
    } catch {
      socket.destroy()
      return
    }
    const subpath = WS_ROUTES[url.pathname]
    if (!subpath) {
      // Not a path we bridge — reject the upgrade cleanly.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
      socket.destroy()
      return
    }

    // Auth: Authorization/x-api-key header, or ?api_key= for header-less clients.
    const queryKey = url.searchParams.get("api_key") ?? undefined
    const authed = isAuthorized((name) => {
      const raw = req.headers[name.toLowerCase()]
      const val = Array.isArray(raw) ? raw[0] : raw
      if (val) return val
      if (name.toLowerCase() === "authorization" && queryKey) return `Bearer ${queryKey}`
      return undefined
    })
    if (!authed) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (client) => bridge(client, req, subpath, url.search))
  })

  logger.info({ paths: Object.keys(WS_ROUTES) }, "ws bridge attached")
}

/** WebSocket close codes clients may not send back are remapped to 1011. */
function safeCode(code: number): number {
  if (code === 1000 || code === 1001) return code
  if (code >= 3000 && code <= 4999) return code
  return 1011
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(safeCode(code), reason.slice(0, 120))
  } catch {
    try {
      ws.terminate()
    } catch {
      /* ignore */
    }
  }
}

function bridge(client: WebSocket, req: IncomingMessage, subpath: string, search: string): void {
  const cfg = getOpenAIConfig({})
  if (!cfg.apiKey) {
    closeQuietly(client, 1011, "openai upstream is not configured")
    return
  }

  // Build the upstream wss URL from the resolved OpenAI base (http→ws, https→wss).
  const base = cfg.baseUrl.replace(/\/+$/, "")
  const wsBase = base.replace(/^http/i, "ws")
  const upstreamUrl = `${wsBase}${subpath}${search}`

  // The Netlify AI Gateway can't do wss — fail fast with a clear reason instead
  // of a confusing hang, so the operator knows to use a direct OpenAI key.
  if (/\.netlify\.app\//i.test(base) || base.includes("/.netlify/ai")) {
    logger.warn({ origin: cfg.origin }, "ws bridge: upstream is not wss-capable")
    closeQuietly(client, 1011, "upstream does not support wss (use a direct OpenAI key)")
    return
  }

  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` }
  for (const h of FORWARD_HEADERS) {
    const v = req.headers[h]
    if (typeof v === "string") headers[h] = v
  }

  const upstream = new WebSocket(upstreamUrl, { headers })
  const pending: Array<{ data: RawData; binary: boolean }> = []
  let closed = false

  const shutdown = (code: number, reason: string) => {
    if (closed) return
    closed = true
    closeQuietly(client, code, reason)
    closeQuietly(upstream, code, reason)
  }

  upstream.on("open", () => {
    for (const m of pending) {
      try {
        upstream.send(m.data, { binary: m.binary })
      } catch {
        /* ignore */
      }
    }
    pending.length = 0
  })

  client.on("message", (data: RawData, isBinary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pending.push({ data, binary: isBinary })
    }
  })
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })

  client.on("close", (code, reason) => shutdown(code, reason?.toString() ?? ""))
  upstream.on("close", (code, reason) => shutdown(code, reason?.toString() ?? ""))
  client.on("error", () => shutdown(1011, "client error"))
  upstream.on("error", (err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ws bridge upstream error")
    shutdown(1011, "upstream error")
  })
}
