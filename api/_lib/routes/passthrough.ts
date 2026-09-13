import type { Request, Response } from "express"
import { getOpenAIConfig, getAnthropicConfig, readOidcToken, fetchUpstream, type UpstreamConfig } from "../upstream.js"
import { applyModelMap } from "../models.js"
import { safeCancel, readWithStall, stallTimeoutMs } from "../sse.js"
import { logger } from "../logger.js"

/**
 * Generic OpenAI-format passthrough for endpoints beyond chat/completions
 * (e.g. `/v1/alpha/search`, `/v1/responses`, `/v1/embeddings`). The request
 * method, query string, and JSON body are forwarded verbatim to the OpenAI
 * upstream, and the upstream response is streamed back raw with its status and
 * content-type preserved — so it works for both JSON and SSE, GET and POST,
 * without knowing the schema.
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

  const headers: Record<string, string> = { authorization: `Bearer ${cfg.apiKey}` }
  return proxyRaw(req, res, cfg, subpath, headers, "openai")
}

/**
 * Anthropic-native passthrough for endpoints beyond /v1/messages — currently
 * `/v1/messages/count_tokens`, which Claude Code calls before requests. Same
 * auth-header selection as the messages route (x-api-key for direct upstreams,
 * Bearer + `anthropic/model` prefix for unified gateways).
 */
export async function handleAnthropicPassthrough(req: Request, res: Response, subpath: string) {
  const ctx = { oidcToken: readOidcToken(req) }
  const cfg = getAnthropicConfig(ctx)
  if (!cfg.apiKey) {
    return res.status(503).json({
      error: {
        message: "anthropic upstream is not configured. Set AI_INTEGRATIONS_ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY.",
        type: "configuration_error",
      },
    })
  }

  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" }
  if (cfg.gateway) headers.authorization = `Bearer ${cfg.apiKey}`
  else headers["x-api-key"] = cfg.apiKey

  // Gateway mode routes by `provider/model` — apply the same rewrite messages get.
  const body = req.body as { model?: string } | undefined
  if (body?.model) {
    body.model = applyModelMap(body.model)
    if (cfg.gateway && !body.model.includes("/")) body.model = `anthropic/${body.model}`
  }
  return proxyRaw(req, res, cfg, subpath, headers, "anthropic")
}

/** Forward the request verbatim and stream the response back raw. */
async function proxyRaw(
  req: Request,
  res: Response,
  cfg: UpstreamConfig,
  subpath: string,
  headers: Record<string, string>,
  which: "openai" | "anthropic",
) {
  const method = (req.method || "POST").toUpperCase()
  const qIndex = req.originalUrl.indexOf("?")
  const search = qIndex >= 0 ? req.originalUrl.slice(qIndex) : ""
  const url = `${cfg.baseUrl}${subpath}${search}`

  let bodyStr: string | undefined
  if (method !== "GET" && method !== "HEAD" && req.body && Object.keys(req.body).length > 0) {
    if (which === "openai" && (req.body as { model?: string }).model) {
      const b = req.body as { model?: string }
      b.model = applyModelMap(b.model!)
      if (cfg.gateway && !b.model.includes("/")) b.model = `openai/${b.model}`
    }
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
  const stallMs = stallTimeoutMs()
  try {
    for (;;) {
      const result = await readWithStall(reader, stallMs)
      if (result === "stall") {
        logger.warn({ subpath }, "passthrough stream stalled — aborting")
        safeCancel(reader)
        break
      }
      if (result.done) break
      if (result.value) res.write(Buffer.from(result.value))
    }
  } catch (err) {
    logger.error({ err, subpath }, `${which} passthrough stream error`)
  } finally {
    if (!res.writableEnded) res.end()
  }
}
