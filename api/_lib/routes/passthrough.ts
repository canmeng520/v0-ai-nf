import type { Request, Response } from "express"
import { getOpenAIConfig, readOidcToken, fetchUpstream } from "../upstream.js"
import { safeCancel } from "../sse.js"
import { logger } from "../logger.js"

/**
 * Generic OpenAI-format passthrough for endpoints beyond chat/completions
 * (e.g. `/v1/alpha/search`, `/v1/responses`). The request method, query string,
 * and JSON body are forwarded verbatim to the OpenAI upstream, and the upstream
 * response is streamed back raw with its status and content-type preserved — so
 * it works for both JSON and SSE, GET and POST, without knowing the schema.
 *
 * `subpath` is appended to the upstream base the same way chat/completions is
 * (base `.../v1` + `/alpha/search`, or the Netlify gateway base + `/alpha/search`).
 */
export async function handleOpenAIPassthrough(req: Request, res: Response, subpath: string) {
  const ctx = { oidcToken: readOidcToken(req) }
  const cfg = getOpenAIConfig(ctx)
  if (!cfg.apiKey) {
    return res.status(503).json({
      error: {
        message: "openai upstream is not configured. Set AI_INTEGRATIONS_OPENAI_API_KEY or AI_GATEWAY_API_KEY.",
        type: "configuration_error",
      },
    })
  }

  const method = (req.method || "POST").toUpperCase()
  const qIndex = req.originalUrl.indexOf("?")
  const search = qIndex >= 0 ? req.originalUrl.slice(qIndex) : ""
  const url = `${cfg.baseUrl}${subpath}${search}`

  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` }
  let bodyStr: string | undefined
  if (method !== "GET" && method !== "HEAD" && req.body && Object.keys(req.body).length > 0) {
    headers["content-type"] = "application/json"
    bodyStr = JSON.stringify(req.body)
  }

  const upstreamRes = await fetchUpstream(url, { method, headers, body: bodyStr })

  // Pass status + content-type through; stream the body raw (handles JSON & SSE).
  res.status(upstreamRes.status)
  const ct = upstreamRes.headers.get("content-type")
  if (ct) res.setHeader("content-type", ct)
  if (!upstreamRes.body) {
    res.end()
    return
  }
  const reader = upstreamRes.body.getReader()
  res.on("close", () => safeCancel(reader))
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
  } catch (err) {
    logger.error({ err, subpath }, "openai passthrough stream error")
  } finally {
    if (!res.writableEnded) res.end()
  }
}
