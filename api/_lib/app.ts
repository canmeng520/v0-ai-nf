import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import { logger } from "./logger.js"
import { bearerAuth } from "./auth.js"
import { listModels, debugEnabled } from "./models.js"
import { buildHealth } from "./health.js"
import { handleChatCompletions } from "./routes/chat-completions.js"
import { handleMessages } from "./routes/messages.js"
import { readOidcToken, UpstreamUnreachableError } from "./upstream.js"
import { redactErrorMessage } from "./redact.js"

export function createApp() {
  const app = express()

  app.disable("x-powered-by")
  app.use(cors({ origin: true, credentials: false }))
  app.use(express.json({ limit: "50mb" }))
  app.use(express.urlencoded({ extended: true, limit: "50mb" }))

  // Lightweight request log (Vercel already records request metadata; this just
  // adds the route + status to function logs without pulling in pino-http).
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    res.on("finish", () => {
      logger.info(
        { method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - start },
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
    const message = err instanceof Error ? redactErrorMessage(err) : "internal server error"
    res.status(500).json({ error: { message, type: "internal_error" } })
  })

  return app
}

export const app = createApp()
export default app
