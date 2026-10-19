import http from "node:http"
import { app } from "./api/_lib/app.js"
import { attachWsBridge } from "./api/_lib/ws-bridge.js"
import { logger } from "./api/_lib/logger.js"

const port = Number(process.env.PORT ?? 8787)
const server = http.createServer(app)
attachWsBridge(server)

// reusePort lets a hot-update container bind the same port before this one
// leaves; on SIGTERM stop accepting, let in-flight streams finish, then exit.
server.listen({ port, reusePort: true }, () => {
  logger.info({ port }, "ai-proxy api listening (dev)")
})

let draining = false
const drain = (sig: string) => {
  if (draining) return
  draining = true
  const maxMs = Number(process.env.DRAIN_MS ?? 5 * 60_000)
  logger.info({ sig, maxMs }, "draining")
  server.close(() => process.exit(0))
  server.closeIdleConnections()
  setInterval(() => server.closeIdleConnections(), 1000).unref()
  setTimeout(() => process.exit(0), maxMs).unref()
}
process.on("SIGTERM", () => drain("SIGTERM"))
process.on("SIGINT", () => drain("SIGINT"))
