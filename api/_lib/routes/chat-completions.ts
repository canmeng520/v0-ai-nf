import type { Request, Response } from "express"
import { getProvider } from "../models.js"
import {
  getOpenAIConfig,
  getAnthropicConfig,
  readOidcToken,
  readUpstreamError,
  type UpstreamConfig,
} from "../upstream.js"
import { safeCancel } from "../sse.js"
import { acquireStreamingUpstream, acquireUpstream } from "../forward.js"
import { openaiToAnthropicRequest, anthropicResponseToOpenai, isReasoningModel } from "../convert.js"
import { pipeAnthropicStreamToOpenai } from "../stream-convert.js"
import { logger } from "../logger.js"
import type { OpenAIChatRequest } from "../types.js"

export async function handleChatCompletions(req: Request, res: Response) {
  const body = req.body as OpenAIChatRequest
  if (!body || typeof body !== "object" || !body.model || !Array.isArray(body.messages)) {
    return res.status(400).json({
      error: { message: "Request must include `model` and `messages`.", type: "invalid_request_error" },
    })
  }

  const provider = getProvider(body.model)
  const wantStream = body.stream === true
  const ctx = { oidcToken: readOidcToken(req) }
  const openaiCfg = getOpenAIConfig(ctx)
  const anthropicCfg = getAnthropicConfig(ctx)

  // Strategy:
  // 1. OpenAI-format request + provider=openai → use openai upstream (or gateway with `openai/...`).
  // 2. OpenAI-format request + provider=anthropic + openai upstream is gateway → call gateway as
  //    OpenAI-compatible with `anthropic/<model>` (gateway handles cross-provider routing). No conversion needed.
  // 3. Otherwise (real OpenAI configured but model is anthropic) → convert OpenAI→Anthropic format
  //    and call anthropic upstream.
  if (provider === "openai") {
    if (!openaiCfg.apiKey) return missingUpstream(res, "openai")
    return forwardOpenAIChat(body, wantStream, res, openaiCfg, "openai")
  }

  // provider === "anthropic"
  if (openaiCfg.gateway) {
    return forwardOpenAIChat(body, wantStream, res, openaiCfg, "anthropic")
  }
  if (!anthropicCfg.apiKey) return missingUpstream(res, "anthropic")
  return forwardAnthropicAsOpenAI(body, wantStream, res, anthropicCfg)
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

async function forwardOpenAIChat(
  body: OpenAIChatRequest,
  wantStream: boolean,
  res: Response,
  cfg: UpstreamConfig,
  modelProvider: "openai" | "anthropic",
) {
  const outBody: OpenAIChatRequest = { ...body }
  // gpt-5 / o-series reject `max_tokens`; translate a client-sent value so plain
  // passthrough requests don't 400 on those models.
  if (isReasoningModel(body.model) && outBody.max_tokens != null && outBody.max_completion_tokens == null) {
    outBody.max_completion_tokens = outBody.max_tokens
    delete outBody.max_tokens
  }
  if (cfg.gateway) {
    outBody.model = `${modelProvider}/${body.model}`
  }
  const url = `${cfg.baseUrl}/chat/completions`
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(outBody),
  }

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, url, init, "openai")
    if (!upstreamRes) return // client error forwarded, or SSE error already emitted
    const reader = upstreamRes.body!.getReader()
    res.on("close", () => safeCancel(reader))
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) res.write(Buffer.from(value))
      }
    } catch (err) {
      logger.error({ err }, "openai-format stream pass-through error")
    } finally {
      if (!res.writableEnded) res.end()
    }
    return
  }

  const upstreamRes = await acquireUpstream(url, init)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw, origin: cfg.origin }, "openai-format upstream error")
    return res.status(status).json(errBody)
  }
  const json = await upstreamRes.json()
  return res.status(200).json(json)
}

async function forwardAnthropicAsOpenAI(
  body: OpenAIChatRequest,
  wantStream: boolean,
  res: Response,
  cfg: UpstreamConfig,
) {
  const anthropicReq = openaiToAnthropicRequest(body)
  anthropicReq.stream = wantStream
  const url = `${cfg.baseUrl}/v1/messages`
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(anthropicReq),
  }

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, url, init, "openai")
    if (!upstreamRes) return
    res.on("close", () => safeCancel(upstreamRes.body))
    await pipeAnthropicStreamToOpenai(upstreamRes.body!, res, body.model)
    return
  }

  const upstreamRes = await acquireUpstream(url, init)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "anthropic upstream error (chat conversion)")
    return res.status(status).json(errBody)
  }
  const upstreamJson = await upstreamRes.json()
  const converted = anthropicResponseToOpenai(upstreamJson as never)
  return res.status(200).json(converted)
}
