import type { IncomingMessage, ServerResponse } from "node:http"
import { app } from "./_lib/app.js"

/**
 * Single Vercel function that owns ALL gateway traffic.
 *
 * Why a flat filename instead of `[...slug].ts`?
 * Vercel's file-based catch-all routing is unreliable for multi-segment paths
 * (e.g. `/api/v1/models`) when no framework preset is active. Using a fixed
 * filename plus explicit `vercel.json` rewrites is bulletproof.
 *
 * vercel.json rewrites every public path to `/api/proxy?__p=<original-path>`,
 * preserving the original URL via the `__p` query param. We then synthesize
 * `req.url` so the embedded Express app routes exactly as it does locally.
 */
export default function handler(req: IncomingMessage, res: ServerResponse) {
  // Express expects req.url to start with the actual route (e.g. "/v1/models").
  // Vercel-rewritten URL looks like "/api/proxy?__p=v1/models".
  const original = new URL(req.url ?? "/", "http://localhost")
  const encoded = original.searchParams.get("__p") ?? ""
  original.searchParams.delete("__p")

  // Re-build the URL Express should see: "/<__p>?<remaining query>"
  let routePath = encoded.startsWith("/") ? encoded : `/${encoded}`
  if (routePath === "/") routePath = "/"
  const remaining = original.searchParams.toString()
  req.url = remaining ? `${routePath}?${remaining}` : routePath

  return new Promise<void>((resolve) => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      resolve()
    }
    res.on("close", done)
    res.on("finish", done)
    ;(app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res)
  })
}

export const config = {
  // SSE streams can run for several minutes.
  maxDuration: 300,
}
