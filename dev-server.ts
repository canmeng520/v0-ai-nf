// Local development / self-host server. Runs the same Express app the Vercel
// catch-all uses, plus the WebSocket bridge (wss:// for Codex Responses /
// Realtime), which only works on a long-running server like this one.
import { app } from "./api/_lib/app.js"
import { attachWsBridge } from "./api/_lib/ws-bridge.js"
import { logger } from "./api/_lib/logger.js"

const port = Number(process.env.PORT ?? 8787)
const server = app.listen(port, () => {
  logger.info({ port }, "ai-proxy api listening (dev)")
})

// wss://<host>/v1/responses (and /v1/realtime) — bridged to the OpenAI upstream.
attachWsBridge(server)
