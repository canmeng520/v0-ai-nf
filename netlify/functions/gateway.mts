// Netlify Function that owns ALL gateway traffic (health, models, chat, messages).
//
// It reuses the exact same handlers as the Express app (local + Vercel) via a
// tiny Web⇄Express adapter, so routing, auth, format conversion and SSE streaming
// live in one place under api/_lib. Bound directly to the public paths through
// `config.path` below, so the original request URL reaches this function
// unchanged (no netlify.toml rewrites, no lost path segments).
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"
import { toExpressReq, WebResShim } from "../../api/_lib/web-adapter.js"
import { isAuthorized, UNAUTHORIZED_BODY } from "../../api/_lib/auth.js"
import { buildHealth } from "../../api/_lib/health.js"
import { listModels, debugEnabled } from "../../api/_lib/models.js"
import { handleChatCompletions } from "../../api/_lib/routes/chat-completions.js"
import { handleMessages } from "../../api/_lib/routes/messages.js"
import { redactErrorMessage } from "../../api/_lib/redact.js"

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const pathname = url.pathname
  const debug = debugEnabled() && (url.searchParams.get("debug") === "1" || url.searchParams.get("debug") === "true")
  const res = new WebResShim(request.signal)

  // CORS — mirrors the Express `cors({ origin: true })` middleware.
  res.setHeader("access-control-allow-origin", request.headers.get("origin") ?? "*")
  res.setHeader("vary", "Origin")
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  res.setHeader(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ?? "authorization,x-api-key,content-type,anthropic-version",
  )

  if (request.method === "OPTIONS") {
    res.status(204).end()
    return res.getResponse()
  }

  const req = await toExpressReq(request, pathname)
  // Cast: the shims implement exactly the slice of Express req/res the handlers use.
  const xreq = req as unknown as ExpressRequest
  const xres = res as unknown as ExpressResponse

  // Run the matched handler WITHOUT awaiting completion, then return the response
  // as soon as headers commit — streaming handlers keep writing the body after.
  void dispatch(pathname, request.method, xreq, res).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: err instanceof Error ? redactErrorMessage(err) : "internal server error", type: "internal_error" },
      })
    } else if (!res.writableEnded) {
      res.end()
    }
  })

  return res.getResponse()

  // ----- routing (shares the same handlers as api/_lib/app.ts) -----
  async function dispatch(path: string, method: string, r: ExpressRequest, w: WebResShim) {
    if ((path === "/api/healthz" || path === "/healthz") && method === "GET") {
      w.json(buildHealth({}))
      return
    }

    if (path === "/v1/models" && method === "GET") {
      if (!isAuthorized((n) => r.header(n) ?? undefined)) {
        w.status(401).json(UNAUTHORIZED_BODY)
        return
      }
      const ml = await listModels({}, { debug })
      w.json({ object: "list", data: ml.data, ...(ml._debug ? { _debug: ml._debug } : {}) })
      return
    }

    if (path === "/v1/chat/completions" && method === "POST") {
      if (!isAuthorized((n) => r.header(n) ?? undefined)) {
        w.status(401).json(UNAUTHORIZED_BODY)
        return
      }
      await handleChatCompletions(r, xres)
      return
    }

    if (path === "/v1/messages" && method === "POST") {
      if (!isAuthorized((n) => r.header(n) ?? undefined)) {
        w.status(401).json(UNAUTHORIZED_BODY)
        return
      }
      await handleMessages(r, xres)
      return
    }

    w.status(404).json({ error: { message: `Not found: ${method} ${path}`, type: "not_found" } })
  }
}

export const config = {
  path: ["/api/healthz", "/healthz", "/v1", "/v1/models", "/v1/chat/completions", "/v1/messages"],
}
