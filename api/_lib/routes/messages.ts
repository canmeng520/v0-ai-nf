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
  body.model = applyModelMap(body.model)

  const provider = getProvider(body.model)
  const wantStream = body.stream === true
  const ctx = { oidcToken: readOidcToken(req) }
  const openaiChain = getOpenAIConfigChain(ctx).filter((c) => c.apiKey)
  const anthropicChain = getAnthropicConfigChain(ctx).filter((c) => c.apiKey)

  // Strategy (unchanged selection, now with failover chains):
  // 1. provider=anthropic → the Anthropic chain (native or gateway per entry).
  // 2. provider=openai + primary Anthropic upstream is a unified gateway → call
  //    the gateway's /v1/messages with `openai/<model>` (gateway entries only).
  // 3. Otherwise → convert Anthropic→OpenAI and use the OpenAI chain.
  if (provider === "anthropic") {
    if (anthropicChain.length === 0) return missingUpstream(res, "anthropic")
    return forwardAnthropicMessages(body, wantStream, res, anthropicChain, "anthropic")
  }

  // provider === "openai"
  const gatewayEntries = anthropicChain.filter((c) => c.gateway)
  if (anthropicChain[0]?.gateway && gatewayEntries.length > 0) {
    return forwardAnthropicMessages(body, wantStream, res, gatewayEntries, "openai")
  }
  if (openaiChain.length === 0) return missingUpstream(res, "openai")
  return forwardOpenAIAsAnthropic(body, wantStream, res, openaiChain)
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
  chain: UpstreamConfig[],
  modelProvider: "openai" | "anthropic",
) {
  const candidates = buildAnthropicCandidates(body, chain, modelProvider)

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, candidates, "anthropic")
    if (!upstreamRes) return
    await pumpRawStream(upstreamRes.body!, res, "anthropic")
    return
  }

  const upstreamRes = await acquireUpstream(candidates)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "anthropic-format upstream error")
    return res.status(status).json(errBody)
  }
  const json = await readUpstreamJson(upstreamRes)
  return res.status(200).json(json)
}

async function forwardOpenAIAsAnthropic(
  body: AnthropicMessagesRequest,
  wantStream: boolean,
  res: Response,
  chain: UpstreamConfig[],
) {
  const openaiReq = anthropicToOpenaiRequest(body)
  openaiReq.stream = wantStream
  const candidates = buildOpenAICandidates(openaiReq, chain, "openai")

  if (wantStream) {
    const upstreamRes = await acquireStreamingUpstream(res, candidates, "anthropic")
    if (!upstreamRes) return
    res.on("close", () => safeCancel(upstreamRes.body))
    await pipeOpenaiStreamToAnthropic(upstreamRes.body!, res, body.model)
    return
  }

  const upstreamRes = await acquireUpstream(candidates)
  if (!upstreamRes.ok || !upstreamRes.body) {
    const { status, raw, body: errBody } = await readUpstreamError(upstreamRes)
    logger.warn({ status, raw }, "openai upstream error (messages conversion)")
    return res.status(status).json(errBody)
  }
  const upstreamJson = await readUpstreamJson(upstreamRes)
  const converted = openaiResponseToAnthropic(upstreamJson as never)
  return res.status(200).json(converted)
}
