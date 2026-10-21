import type { Request, Response } from "express"
import { getOpenAIConfig, getAnthropicConfig, readOidcToken, fetchUpstream, type UpstreamConfig } from "../upstream.js"
import { applyModelMap, isImageModel, imageModelMisuse } from "../models.js"
import { safeCancel, readWithStall, stallTimeoutMs } from "../sse.js"
import { logger } from "../logger.js"
import { redactDeep, redactUrls } from "../redact.js"

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

// gpt-image-* always answer with b64_json and 400 on `response_format`
// ("Unknown parameter"), which DALL·E-era clients still send. Drop it for them;
// dall-e-* keep it (they support url/b64_json).
const isGptImage = (model: unknown) => typeof model === "string" && /^(openai\/)?gpt-image/i.test(model)

/** Remove the `response_format` part from a gpt-image multipart body (edits/variations). */
export function stripGptImageMultipart(body: Buffer, contentType: string): Buffer {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)
  if (!boundary) return body
  // latin1 maps bytes 1:1, so binary image parts survive the round trip.
  const s = body.toString("latin1")
  const model = /\r\nContent-Disposition:[^\r\n]*\bname="model"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([^\r\n]*)/i.exec("\r\n" + s)?.[1]
  if (!isGptImage(model?.trim())) return body
  const delim = `--${boundary[1] ?? boundary[2]}`
  const parts = s.split(delim)
  const kept = parts.filter((p) => !/^\r\nContent-Disposition:[^\r\n]*\bname="response_format"/i.test(p))
  return kept.length === parts.length ? body : Buffer.from(kept.join(delim), "latin1")
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

  // Image models are only served on /images/* — reject them anywhere else.
  const reqModel = Buffer.isBuffer(req.body) ? undefined : (req.body as { model?: unknown } | undefined)?.model
  if (!subpath.startsWith("/images/") && typeof reqModel === "string" && isImageModel(applyModelMap(reqModel))) {
    return res.status(400).json(imageModelMisuse(reqModel))
  }

  let bodyStr: string | Buffer | undefined
  if (Buffer.isBuffer(req.body)) {
    // Raw multipart (image edits/variations): forward bytes + original
    // content-type (it carries the boundary). MODEL_MAP can't apply here.
    headers["content-type"] = String(req.headers["content-type"] ?? "application/octet-stream")
    bodyStr = subpath.startsWith("/images/") ? stripGptImageMultipart(req.body, headers["content-type"]) : req.body
  } else if (method !== "GET" && method !== "HEAD") {
    if (which === "openai" && req.body && (req.body as { model?: string }).model) {
      const b = req.body as { model?: string; response_format?: unknown }
      b.model = applyModelMap(b.model!)
      if (subpath.startsWith("/images/") && isGptImage(b.model)) delete b.response_format
      if (cfg.gateway && !b.model.includes("/")) b.model = `openai/${b.model}`
    }
    // Always send content-type + a JSON body (even `{}`) on writes — some
    // gateways 400 a POST without a content-type (e.g. Codex's body-less cancel).
    headers["content-type"] = "application/json"
    bodyStr = JSON.stringify(req.body ?? {})
  }

  // Reasoning models (Codex on /v1/responses, o-series) can take well over the
  // default 30s first-byte window to emit their first token. Self-host has no
  // ~60s wall, so allow a generous first-byte timeout here; PASSTHROUGH_FIRST_BYTE_MS
  // overrides (default 120s). Keep retries low so a genuine hang fails fast.
  const fbEnv = Number(process.env.PASSTHROUGH_FIRST_BYTE_MS)
  const firstByteMs = Number.isFinite(fbEnv) && fbEnv > 0 ? fbEnv : 120_000
  // retries=3: a proxy ECONNRESET before the first byte is safe to retry and
  // recovers instantly; a genuine slow first byte doesn't retry (it succeeds
  // within firstByteMs), so this rarely adds latency.
  const upstreamRes = await fetchUpstream(url, { method, headers, body: bodyStr }, 3, firstByteMs)

  // Pass status + content-type through; stream the body raw (handles JSON & SSE).
  res.status(upstreamRes.status)
  const ct = upstreamRes.headers.get("content-type")
  if (ct) res.setHeader("content-type", ct)
  if (!upstreamRes.body) {
    res.end()
    return
  }
  const isSse = (ct ?? "").includes("text/event-stream")
  // Error bodies are small: buffer them and strip upstream URLs / platform
  // fingerprints (e.g. a hosting 404 page) before the client sees them.
  if (upstreamRes.status >= 400 && !isSse) {
    const text = await upstreamRes.text().catch(() => "")
    let out: string
    try {
      out = JSON.stringify(redactDeep(JSON.parse(text)))
    } catch {
      out = redactUrls(text)
    }
    res.end(out)
    return
  }
  const reader = upstreamRes.body.getReader()
  res.on("close", () => safeCancel(reader))
  const stallMs = stallTimeoutMs()
  const t0 = Date.now()
  let sawTerminal = false // Responses stream reached a terminal event
  let abnormal = false // stall / mid-stream throw — stream did not end cleanly
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const result = await readWithStall(reader, stallMs)
      if (result === "stall") {
        logger.warn({ subpath, ms: Date.now() - t0 }, "passthrough stream stalled — aborting")
        safeCancel(reader)
        abnormal = true
        break
      }
      if (result.done) break
      if (result.value) {
        if (isSse && !sawTerminal) {
          const text = decoder.decode(result.value, { stream: true })
          // Responses terminal events; `[DONE]` covers the chat/completions shape.
          if (/response\.(completed|incomplete|failed)|message_stop|\[DONE\]/.test(text)) sawTerminal = true
        }
        res.write(Buffer.from(result.value))
      }
    }
  } catch (err) {
    logger.error({ err, subpath, ms: Date.now() - t0 }, `${which} passthrough stream error`)
    abnormal = true
  } finally {
    // If a Responses SSE stream ended WITHOUT a terminal event (upstream/Netlify
    // cut it mid-stream), synthesize `response.failed` so the client sees a clean,
    // parseable end instead of a bare EOF ("stream closed before response.completed").
    if (isSse && !sawTerminal && !res.writableEnded) {
      logger.warn({ subpath, ms: Date.now() - t0, abnormal }, "responses stream ended without terminal event — synthesizing response.failed")
      const evt = {
        type: "response.failed",
        response: { status: "failed", error: { code: "upstream_incomplete", message: "upstream stream closed before completion" } },
      }
      try {
        res.write(`event: response.failed\ndata: ${JSON.stringify(evt)}\n\n`)
      } catch {
        /* ignore */
      }
    }
    if (!res.writableEnded) res.end()
  }
}
