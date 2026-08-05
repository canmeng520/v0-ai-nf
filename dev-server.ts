// Local development server. Runs the same Express app the Vercel catch-all uses.
import { app } from "./api/_lib/app.js"
import { logger } from "./api/_lib/logger.js"

const port = Number(process.env.PORT ?? 8787)
app.listen(port, () => {
  logger.info({ port }, "ai-proxy api listening (dev)")
})
