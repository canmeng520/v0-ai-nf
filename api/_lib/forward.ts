import type { Response as ExpressResponse } from "express"
import {
  fetchUpstream,
  fetchUpstreamUntil,
  readUpstreamError,
  isRetryableStatus,
  sanitizeAnthropicBody,
  UpstreamUnreachableError,
  type UpstreamConfig,
} from "./upstream.js"
import { isReasoningModel } from "./convert.js"
import type { OpenAIChatRequest, AnthropicMessagesRequest } from "./types.js"
import {
  setSseHeaders,
  startKeepalive,
  writeSseData,
  writeSseDone,
  writeSseEvent,
  safeCancel,
  readWithStall,
  stallTimeoutMs,
  type StreamFormat,
} from "./sse.js"
import { logger } from "./logger.js"

/**
 * One fully-built upstream request. Routes build one candidate per entry of the
 * credential chain (body/headers differ per entry: gateway mode prefixes the
 * model with `provider/` and uses Bearer auth), and forward.ts fails over down
 * the list — sub2api's account-switching adapted to our credential resolution.
 */
export interface UpstreamCandidate {
  url: string
  init: RequestInit
  /** For logs only. */
  origin: string
}

/** Build one OpenAI chat/completions request per credential-chain entry. */
export function buildOpenAICandidates(
  body: OpenAIChatRequest,
  chain: UpstreamConfig[],
  modelProvider: "openai" | "anthropic",
): UpstreamCandidate[] {
  return chain.map((cfg) => {
    const outBody: OpenAIChatRequest = { ...body }
    // gpt-5+ / o-series reject `max_tokens`; translate a client-sent value so
    // plain passthrough requests don't 400 on those models.
    if (isReasoningModel(body.model) && outBody.max_tokens != null && outBody.max_completion_tokens == null) {
      outBody.max_completion_tokens = outBody.max_tokens
      delete outBody.max_tokens
    }
    if (cfg.gateway) outBody.model = `${modelProvider}/${body.model}`
    return {
      url: `${cfg.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(outBody),
      },
      origin: cfg.origin,
    }
  })
}

/** Build one Anthropic /v1/messages request per credential-chain entry. */
export function buildAnthropicCandidates(
  anthropicReq: AnthropicMessagesRequest,
  chain: UpstreamConfig[],
  modelProvider: "openai" | "anthropic",
): UpstreamCandidate[] {
  return chain.map((cfg) => {
    const outBody: AnthropicMessagesRequest = sanitizeAnthropicBody({ ...anthropicReq }, cfg)
    if (cfg.gateway) outBody.model = `${modelProvider}/${anthropicReq.model}`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    }
    if (cfg.gateway) headers.authorization = `Bearer ${cfg.apiKey}`
    else headers["x-api-key"] = cfg.apiKey
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      init: { method: "POST", headers, body: JSON.stringify(outBody) },
      origin: cfg.origin,
    }
  })
}

// Netlify's sync function timeout defaults to ~30s. We keep the retry-wait window
// below it so we return a clean error rather than getting killed mid-response,
// leaving headroom for the eventual successful upstream call to actually run.

/** How long a streaming request keeps retrying a transiently-failing upstream
 * (behind an already-open SSE heartbeat) before giving up. Waiting counts against
 * the function budget, so leave room for the stream itself. Override with
 * UPSTREAM_STREAM_RETRY_MS. */
function streamDeadlineMs(): number {
  const v = Number(process.env.UPSTREAM_STREAM_RETRY_MS)
  return Number.isFinite(v) && v > 0 ? v : 20_000
}

/** How long a NON-streaming request rides out a transiently-failing upstream
 * before returning 502. Nothing reaches the client until the whole call returns,
 * so this + the successful call must fit the ~30s function timeout. Override with
 * UPSTREAM_NONSTREAM_RETRY_MS. */
function nonStreamDeadlineMs(): number {
  const v = Number(process.env.UPSTREAM_NONSTREAM_RETRY_MS)
  return Number.isFinite(v) && v > 0 ? v : 18_000
}

/**
 * A status worth advancing to the NEXT credential for. 401/403 = this upstream's
 * key is bad (the fallback may work); 404 = model not served here (a gateway
 * often serves what a custom base doesn't); 429/5xx = this upstream is
 * limited/degraded. 400/413/422 are request problems — identical on any
 * upstream, so failing over just doubles latency.
 */
function isFailoverStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 429 || status >= 500
}

/**
 * Non-streaming acquire over the candidate chain. Rides out candidate[0] as
 * before; on exhaustion or a failover-worthy status, advances to the next
 * candidate within the same overall deadline (each candidate gets an equal
 * slice of what remains so the fallback always has budget). Returns a Response
 * (ok, or the best failure to forward). Throws UpstreamUnreachableError when
 * every candidate stayed unreachable.
 */
export async function acquireUpstream(candidates: UpstreamCandidate[]): Promise<Response> {
  const deadline = Date.now() + nonStreamDeadlineMs()
  let lastFailure: Response | null = null
  let lastError: string | undefined
  let totalAttempts = 0

  for (let i = 0; i < candidates.length; i++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const slice = Math.max(2_000, Math.floor(remaining / (candidates.length - i)))
    const c = candidates[i]
    const { res, attempts, lastError: err } = await fetchUpstreamUntil(c.url, c.init, Math.min(slice, remaining))
    totalAttempts += attempts
    if (err) lastError = err
    if (res) {
      if (res.ok) {
        if (i > 0) logger.info({ origin: c.origin, failedOver: i }, "upstream failover succeeded")
        return res
      }
      if (isFailoverStatus(res.status) && i < candidates.length - 1) {
        logger.warn({ origin: c.origin, status: res.status }, "failing over to next upstream")
        supersedeFailure(lastFailure, res)
        lastFailure = res
        continue
      }
      supersedeFailure(lastFailure, res)
      return res // non-failover 4xx, or last candidate — forward the real status
    }
    // network-unreachable for this candidate → try the next
    logger.warn({ origin: c.origin, err: lastError }, "candidate unreachable, advancing")
  }

  if (lastFailure) return lastFailure
  const secs = Math.round(nonStreamDeadlineMs() / 1000)
  throw new UpstreamUnreachableError(
    `upstream unreachable for ${secs}s / ${totalAttempts} attempts across ${candidates.length} upstream(s) (non-stream): ${lastError ?? "fetch failed"}`,
    totalAttempts,
  )
}

/** Cancel the body of a superseded failure response so sockets are released. */
function supersedeFailure(prev: Response | null, next: Response | null): void {
  if (prev && prev !== next) {
    try {
      void prev.body?.cancel()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Get a usable upstream Response for a STREAMING request without ever surfacing
 * a transient 500 to the client:
 *
 *  1. Quick phase (no response headers sent yet): try each candidate with
 *     bounded retries. Success → open the SSE stream + heartbeat and return it.
 *     A NON-failover 4xx (bad request) → forward that real status, no stream.
 *     A failover-worthy status → try the next candidate; a 429/auth failure on
 *     the LAST candidate is also forwarded as its real status (headers not sent
 *     yet) so the client can back off.
 *  2. Transient-failure phase: everything is flaking. Open the SSE stream +
 *     heartbeat NOW (client gets HTTP 200 immediately), then keep retrying the
 *     candidates in order for up to the deadline. On success → return the
 *     Response to pipe. Deadline passed → emit an SSE error in the client's
 *     dialect and return null.
 */
export async function acquireStreamingUpstream(
  res: ExpressResponse,
  candidates: UpstreamCandidate[],
  format: StreamFormat,
): Promise<Response | null> {
  const t0 = Date.now()

  // ---- phase 1: quick attempts, headers not sent yet ----
  let lastFailure: Response | null = null
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    let quick: Response | null = null
    try {
      quick = await fetchUpstream(c.url, c.init, i === 0 ? 2 : 1)
    } catch {
      quick = null // network-unreachable → next candidate / phase 2
    }
    if (quick && quick.ok && quick.body) {
      setSseHeaders(res)
      startKeepalive(res, format)
      logger.info({ origin: c.origin, upstreamHeadersMs: Date.now() - t0, candidate: i }, "stream upstream acquired")
      supersedeFailure(lastFailure, quick)
      return quick
    }
    if (quick && !quick.ok) {
      if (!isFailoverStatus(quick.status)) {
        // Genuine request error — preserve the real status; no stream.
        supersedeFailure(lastFailure, quick)
        const { status, body } = await readUpstreamError(quick)
        res.status(status).json(body)
        return null
      }
      logger.warn({ origin: c.origin, status: quick.status }, "stream quick attempt failing over")
      supersedeFailure(lastFailure, quick)
      lastFailure = quick
    }
  }

  // A definitive failure (429/auth/404) from the chain and headers not sent yet:
  // forward the real status rather than burying it in an SSE error. Only true
  // transients (5xx / network) proceed to the ride-out phase.
  if (lastFailure && (lastFailure.status === 429 || !isRetryableStatus(lastFailure.status))) {
    const { status, body } = await readUpstreamError(lastFailure)
    res.status(status).json(body)
    return null
  }
  supersedeFailure(lastFailure, null)

  // ---- phase 2: transient failure — open the stream + heartbeat, then ride it out ----
  setSseHeaders(res)
  startKeepalive(res, format)
  const deadline = Date.now() + streamDeadlineMs()
  let lastError: string | undefined
  let lastRes: Response | null = null
  for (let i = 0; i < candidates.length; i++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const slice = Math.max(2_000, Math.floor(remaining / (candidates.length - i)))
    const c = candidates[i]
    const { res: good, lastError: err } = await fetchUpstreamUntil(c.url, c.init, Math.min(slice, remaining))
    if (err) lastError = err
    if (good && good.ok && good.body) {
      logger.info({ origin: c.origin, upstreamHeadersMs: Date.now() - t0, candidate: i, phase: 2 }, "stream upstream acquired")
      supersedeFailure(lastRes, good)
      return good
    }
    supersedeFailure(lastRes, good)
    lastRes = good
  }

  let message = `upstream temporarily unavailable: ${lastError ?? "fetch failed"}`
  if (lastRes) {
    const { body } = await readUpstreamError(lastRes)
    message = body.error.message
  }
  emitStreamError(res, format, message)
  if (!res.writableEnded) res.end()
  return null
}

/** Emit a terminal stream error in the client's own SSE dialect. */
export function emitStreamError(res: ExpressResponse, format: StreamFormat, message: string): void {
  if (format === "anthropic") {
    writeSseEvent(res, "error", JSON.stringify({ type: "error", error: { type: "upstream_error", message } }))
  } else {
    writeSseData(res, { error: { message, type: "upstream_error" } })
    writeSseDone(res)
  }
}

/**
 * Pump an upstream SSE body to the client verbatim, with a stall watchdog
 * (sub2api's `stream_data_interval_timeout`): if the upstream goes silent for
 * STREAM_STALL_TIMEOUT_MS mid-stream, cancel it and emit a protocol-correct
 * error instead of hanging until the function is killed. Shared by the two raw
 * passthrough routes. Always ends the response.
 */
export async function pumpRawStream(
  body: ReadableStream<Uint8Array>,
  res: ExpressResponse,
  format: StreamFormat,
): Promise<void> {
  const reader = body.getReader()
  res.on("close", () => safeCancel(reader))
  const stallMs = stallTimeoutMs()
  const t0 = Date.now()
  let bytes = 0
  try {
    for (;;) {
      const result = await readWithStall(reader, stallMs)
      if (result === "stall") {
        logger.warn({ ms: Date.now() - t0, bytes }, "upstream stream stalled — aborting")
        safeCancel(reader)
        emitStreamError(res, format, `upstream stream stalled (no data for ${Math.round(stallMs / 1000)}s)`)
        break
      }
      if (result.done) break
      if (result.value) {
        bytes += result.value.byteLength
        res.write(Buffer.from(result.value))
      }
    }
  } catch (err) {
    logger.error({ err }, "stream pass-through error")
  } finally {
    logger.info({ ms: Date.now() - t0, bytes }, "stream complete")
    if (!res.writableEnded) res.end()
  }
}
