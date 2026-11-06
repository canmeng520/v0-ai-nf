import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import { logger } from "./logger.js"
import { bearerAuth } from "./auth.js"
import { listModels, debugEnabled } from "./models.js"
import { buildHealth } from "./health.js"
import { handleChatCompletions } from "./routes/chat-completions.js"
import { handleMessages } from "./routes/messages.js"
import { handleOpenAIPassthrough, handleAnthropicPassthrough } from "./routes/passthrough.js"
import { handleGemini, handleGeminiModels } from "./routes/gemini.js"
import { fitImageEdit } from "./image-shrink.js"
import { handleImageStream, wantsImageStream } from "./routes/image-stream.js"
import { readOidcToken, UpstreamUnreachableError } from "./upstream.js"
import { redactErrorMessage } from "./redact.js"
import { runDiag } from "./diag.js"

export function createApp() {
  const app = express()

  app.disable("x-powered-by")
  app.use(cors({ origin: true, credentials: false }))
  // Large enough for high-res image edits, which fitImageEdit shrinks below the
  // upstream limit before forwarding. BODY_LIMIT overrides (e.g. "200mb").
  const bodyLimit = process.env.BODY_LIMIT || "100mb"
  app.use(express.json({ limit: bodyLimit }))
  // Multipart uploads (/v1/images/edits) stay raw for verbatim passthrough.
  app.use(express.raw({ type: "multipart/form-data", limit: bodyLimit }))
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }))

  // Lightweight request log (Vercel already records request metadata; this just
  // adds the route + status to function logs without pulling in pino-http).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    res.on("finish", () => {
      logger.info(
        // `?key=` (Gemini clients) must not end up in logs.
        { method: req.method, url: req.originalUrl.replace(/([?&]key=)[^&]*/i, "$1***"), status: res.statusCode, ms: Date.now() - start },
        "request",
      )
    })
    next()
  })

  // ----- public health check (also reachable as /api/healthz via rewrite) -----
  app.get(["/api/healthz", "/healthz"], (req, res) => {
    res.json(buildHealth({ oidcToken: readOidcToken(req) }))
  })

  // ----- authenticated routes -----
  app.get("/v1/models", bearerAuth, (req, res, next) => {
    const debug = debugEnabled() && (req.query.debug === "1" || req.query.debug === "true")
    listModels({ oidcToken: readOidcToken(req) }, { debug })
      .then((r) => res.json({ object: "list", data: r.data, ...(r._debug ? { _debug: r._debug } : {}) }))
      .catch(next)
  })

  app.post("/v1/chat/completions", bearerAuth, (req, res, next) => {
    Promise.resolve(handleChatCompletions(req, res)).catch(next)
  })

  app.post("/v1/messages", bearerAuth, (req, res, next) => {
    Promise.resolve(handleMessages(req, res)).catch(next)
  })

  // Claude Code calls this before requests — forward to the Anthropic upstream.
  app.post("/v1/messages/count_tokens", bearerAuth, (req, res, next) => {
    Promise.resolve(handleAnthropicPassthrough(req, res, "/v1/messages/count_tokens")).catch(next)
  })

  // ----- OpenAI passthrough for extra endpoints (search, responses, …) -----
  // NOTE: `/v1/responses` here is the HTTP+SSE transport. Codex tries a
  // `wss://` upgrade first, which Netlify cannot serve; it then falls back to
  // this POST endpoint. See README "WebSocket / Codex".
  app.all("/v1/alpha/search", bearerAuth, (req, res, next) => {
    Promise.resolve(handleOpenAIPassthrough(req, res, "/alpha/search")).catch(next)
  })

  app.all(["/v1/responses", "/v1/responses/*splat"], bearerAuth, (req, res, next) => {
    const sub = req.path.startsWith("/v1/") ? req.path.slice("/v1".length) : req.path
    Promise.resolve(handleOpenAIPassthrough(req, res, sub)).catch(next)
  })

  app.all("/v1/embeddings", bearerAuth, (req, res, next) => {
    Promise.resolve(handleOpenAIPassthrough(req, res, "/embeddings")).catch(next)
  })

  // Image models (gpt-image-*): /v1/images/generations etc., JSON bodies.
  // Edits first get oversized input images shrunk to fit the upstream limit.
  app.all("/v1/images/*splat", bearerAuth, (req, res, next) => {
    const run = async () => {
      if (req.method === "POST" && req.path === "/v1/images/edits") {
        const reject = await fitImageEdit(req)
        if (reject) return res.status(reject.status).json({ error: { message: reject.message, type: "invalid_request_error", code: "request_too_large" } })
      }
      const sub = req.path.slice("/v1".length)
      if (req.method === "POST" && (sub === "/images/generations" || sub === "/images/edits") && wantsImageStream(req)) {
        return handleImageStream(req, res, sub)
      }
      return handleOpenAIPassthrough(req, res, sub)
    }
    run().catch(next)
  })

  // ----- Google Gemini native API, served by the chat pipeline -----
  // GET /v1/models stays OpenAI's list; Gemini clients list via /v1beta.
  app.get(["/v1beta/models", "/v1beta/models/*splat"], bearerAuth, (req, res, next) => {
    Promise.resolve(handleGeminiModels(req, res)).catch(next)
  })
  app.post(["/v1beta/models/*splat", "/v1/models/*splat"], bearerAuth, (req, res, next) => {
    Promise.resolve(handleGemini(req, res)).catch(next)
  })

  // Claude Code telemetry sink — must never error; auth-free 200 no-op.
  app.post("/api/event_logging/batch", (_req, res) => {
    res.status(200).json({})
  })

  // ----- on-demand upstream diagnostics (auth-gated; masks host) -----
  app.get("/v1/diag", bearerAuth, (req, res, next) => {
    runDiag({ oidcToken: readOidcToken(req) }, req.query as Record<string, string | string[] | undefined>)
      .then((j) => res.json(j))
      .catch(next)
  })

  // ----- 404 -----
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, type: "not_found" } })
  })

  // ----- error handler -----
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, path: req.path }, "unhandled error")
    if (res.headersSent) {
      if (!res.writableEnded) res.end()
      return
    }
    if (err instanceof UpstreamUnreachableError) {
      return res.status(502).json({ error: { message: redactErrorMessage(err), type: "upstream_unreachable", code: 502 } })
    }
    // Body-parser rejections are the client's (413 too large, 400 bad JSON, …): keep their status.
    const status = (err as { status?: unknown } | null)?.status
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message =
        status === 413
          ? `Request body is larger than the ${bodyLimit} limit.`
          : err instanceof Error ? redactErrorMessage(err) : "bad request"
      return res.status(status).json({ error: { message, type: "invalid_request_error", code: status === 413 ? "request_too_large" : status } })
    }
    const message = err instanceof Error ? redactErrorMessage(err) : "internal server error"
    res.status(500).json({ error: { message, type: "internal_error" } })
  })

  return app
}

export const app = createApp()
export default app
