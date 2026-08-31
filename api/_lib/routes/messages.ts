import type { Request, Response } from "express"
import { getProvider } from "../models.js"
import {
  getOpenAIConfig,
  getAnthropicConfig,
  readOidcToken,
  readUpstreamError,
  sanitizeAnthropicBody,
  type UpstreamConfig,
} from "../upstream.js"
import { safeCancel } from "../sse.js"
import { acquireStreamingUpstream, acquireUpstream } from "../forward.js"
import { anthropicToOpenaiRequest, openaiResponseToAnthropic } from "../convert.js"
import { pipeOpenaiStreamToAnthropic } from "../stream-convert.js"
import { logger } from "../logger.js"
import type { AnthropicMessagesRequest } from "../types.js"

export async function handleMessages(req: Request, res: Response) {
  const body = req.body as AnthropicMessagesRequest
  if (!body || typeof body !== "object" || !body.model || !Array.isArray(body.messages)) {
    return res.status(400).json({
      error: { message: "Request must include `model` and `messages`.", type: "invalid_request_error" },
    })
  }
  if (typeof body.max_tokens !== "number") {
    body.max_tokens = 4096
  }

  const provider = getProvider(body.model)
  const wantStream = body.stream === true
  const ctx = { oidcToken: readOidcToken(req) }
  const openaiCfg = getOpenAIConfig(ctx)
  const anthropicCfg = getAnthropicConfig(ctx)

  // Strategy:
  // 1. provider=anthropic → use anthropic upstream (or gateway with `anthropic/...`).
  // 2. provider=openai + anthropic upstream is gateway → call gateway /v1/messages with `openai/<model>`.
  // 3. Otherwise (real Anthropic configured + openai-named model) → convert Anthropic→OpenAI format
  //    and call openai upstream.
  if (provider === "anthropic") {
    if (!anthropicCfg.apiKey) return missingUpstream(res, "anthropic")
    return forwardAnthropicMessages(body, wantStream, res, anthropicCfg, "anthropic")
  }

  // provider === "openai"
  if (anthropicCfg.gateway) {
    return forwardAnthropicMessages(body, wantStream, res, anthropicCfg, "openai")
  }
  if (!openaiCfg.apiKey) return missingUpstream(res, "openai")
  return forwardOpenAIAsAnthropic(body, wantStream, res, openaiCfg)
}

function missingUpstream(res: Response, which: "openai" | "anthropic") {
  const envHint = which === "openai" ? "AI_INTEGRATIONS_OPENAI_API_KEY" : "AI_INTEGRATIONS_ANTHROPIC_API_KEY"
  return res.status(503).json({
    error: {
      message: `${which} upstream is not configured. Set ${envHint} or AI_GATEWAY_API_KEY.`,
      type: "configuration_error",
    },
  })
}

async function forwardAnthropicMessages(
  body: AnthropicMessagesRequest,
  wantStream: boolean,
  res: Response,
  cfg: UpstreamConfig,
  modelProvider: "openai" | "anthropic",
) {
  const outBody: AnthropicMessagesRequest = sanitizeAnthropicBody({ ...body }, cfg)
  if (cfg.gateway) {
    outBody.model = `${modelProvider}/${body.model}`
  }
  const url = `${cfg.baseUrl}/v1/messages`
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  }
  if (cfg.gateway) {
    headers.authorization = `Bearer ${cfg.apiKey}`
  } else {
    headers["x-api-key"] = cfg.apiKey
  }
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(outBody) }

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, url, init, "anthropic")
    if (!upstreamRes) return
    const reader = upstreamRes.body!.getReader()
    res.on("close", () => safeCancel(reader))
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } catch (err) {
      logger.error({ err }, "anthropic-format stream pass-through error")
    } finally {
      if (!res.writableEnded) res.end()
    }
    return
  }

  const upstreamRes = await acquireUpstream(url, init)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw, origin: cfg.origin }, "anthropic-format upstream error")
    return res.status(status).json(errBody)
  }
  const json = await upstreamRes.json()
  return res.status(200).json(json)
}

async function forwardOpenAIAsAnthropic(
  body: AnthropicMessagesRequest,
  wantStream: boolean,
  res: Response,
  cfg: UpstreamConfig,
) {
  const openaiReq = anthropicToOpenaiRequest(body)
  openaiReq.stream = wantStream
  const url = `${cfg.baseUrl}/chat/completions`
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(openaiReq),
  }

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, url, init, "anthropic")
    if (!upstreamRes) return
    res.on("close", () => safeCancel(upstreamRes.body))
    await pipeOpenaiStreamToAnthropic(upstreamRes.body!, res, body.model)
    return
  }

  const upstreamRes = await acquireUpstream(url, init)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "openai upstream error (messages conversion)")
    return res.status(status).json(errBody)
  }
  const upstreamJson = await upstreamRes.json()
  const converted = openaiResponseToAnthropic(upstreamJson as never)
  return res.status(200).json(converted)
}
