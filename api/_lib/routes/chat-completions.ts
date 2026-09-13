import type { Request, Response } from "express"
import { getProvider, applyModelMap } from "../models.js"
import {
  getOpenAIConfigChain,
  getAnthropicConfigChain,
  readOidcToken,
  readUpstreamError,
  readUpstreamJson,
  type UpstreamConfig,
} from "../upstream.js"
import { safeCancel } from "../sse.js"
import {
  acquireStreamingUpstream,
  acquireUpstream,
  pumpRawStream,
  buildOpenAICandidates,
  buildAnthropicCandidates,
} from "../forward.js"
import { openaiToAnthropicRequest, anthropicResponseToOpenai } from "../convert.js"
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
  body.model = applyModelMap(body.model)

  const provider = getProvider(body.model)
  const wantStream = body.stream === true
  const ctx = { oidcToken: readOidcToken(req) }
  const openaiChain = getOpenAIConfigChain(ctx).filter((c) => c.apiKey)
  const anthropicChain = getAnthropicConfigChain(ctx).filter((c) => c.apiKey)

  // Strategy (unchanged selection, now with failover chains):
  // 1. OpenAI-format request + provider=openai → the OpenAI chain.
  // 2. provider=anthropic + primary OpenAI upstream is a unified gateway → call
  //    the gateway's OpenAI surface with `anthropic/<model>` (gateway entries only).
  // 3. Otherwise → convert OpenAI→Anthropic and use the Anthropic chain.
  if (provider === "openai") {
    if (openaiChain.length === 0) return missingUpstream(res, "openai")
    return forwardOpenAIChat(body, wantStream, res, openaiChain, "openai")
  }

  // provider === "anthropic"
  const gatewayEntries = openaiChain.filter((c) => c.gateway)
  if (openaiChain[0]?.gateway && gatewayEntries.length > 0) {
    return forwardOpenAIChat(body, wantStream, res, gatewayEntries, "anthropic")
  }
  if (anthropicChain.length === 0) return missingUpstream(res, "anthropic")
  return forwardAnthropicAsOpenAI(body, wantStream, res, anthropicChain)
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
  chain: UpstreamConfig[],
  modelProvider: "openai" | "anthropic",
) {
  const candidates = buildOpenAICandidates(body, chain, modelProvider)

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, candidates, "openai")
    if (!upstreamRes) return // client error forwarded, or SSE error already emitted
    await pumpRawStream(upstreamRes.body!, res, "openai")
    return
  }

  const upstreamRes = await acquireUpstream(candidates)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "openai-format upstream error")
    return res.status(status).json(errBody)
  }
  const json = await readUpstreamJson(upstreamRes)
  return res.status(200).json(json)
}

async function forwardAnthropicAsOpenAI(
  body: OpenAIChatRequest,
  wantStream: boolean,
  res: Response,
  chain: UpstreamConfig[],
) {
  const anthropicReq = openaiToAnthropicRequest(body)
  anthropicReq.stream = wantStream
  const candidates = buildAnthropicCandidates(anthropicReq, chain, "anthropic")

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, candidates, "openai")
    if (!upstreamRes) return
    res.on("close", () => safeCancel(upstreamRes.body))
    await pipeAnthropicStreamToOpenai(upstreamRes.body!, res, body.model)
    return
  }

  const upstreamRes = await acquireUpstream(candidates)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "anthropic upstream error (chat conversion)")
    return res.status(status).json(errBody)
  }
  const upstreamJson = await readUpstreamJson(upstreamRes)
  const converted = anthropicResponseToOpenai(upstreamJson as never)
  return res.status(200).json(converted)
}
