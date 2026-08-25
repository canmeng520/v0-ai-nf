import express, { type Request, type Response, type NextFunction } from "express"
import cors from "cors"
import { logger } from "./logger.js"
import { bearerAuth } from "./auth.js"
import { listModels } from "./models.js"
import { buildHealth } from "./health.js"
import { handleChatCompletions } from "./routes/chat-completions.js"
import { handleMessages } from "./routes/messages.js"
import { readOidcToken } from "./upstream.js"

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
    listModels({ oidcToken: readOidcToken(req) })
      .then((data) => res.json({ object: "list", data }))
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
    const message = err instanceof Error ? err.message : "internal server error"
    res.status(500).json({ error: { message, type: "internal_error" } })
  })

  return app
}

export const app = createApp()
export default app
