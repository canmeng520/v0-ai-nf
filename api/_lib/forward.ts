import type { Response as ExpressResponse } from "express"
import { fetchUpstream, fetchUpstreamUntil, readUpstreamError, isRetryableStatus } from "./upstream.js"
import { setSseHeaders, startKeepalive, writeSseData, writeSseDone } from "./sse.js"

/** How long a streaming request will keep retrying a transiently-failing upstream
 * (behind an already-open SSE heartbeat) before giving up. The client sees a slow
 * first token instead of a 500. Override with UPSTREAM_STREAM_RETRY_MS. */
function streamDeadlineMs(): number {
  const v = Number(process.env.UPSTREAM_STREAM_RETRY_MS)
  return Number.isFinite(v) && v > 0 ? v : 45_000
}

/**
 * Get a usable upstream Response for a STREAMING request without ever surfacing
 * a transient 500 to the client:
 *
 *  1. Quick phase (no response headers sent yet): try the upstream with the
 *     normal bounded retries. If it succeeds → open the SSE stream + heartbeat
 *     and return it to pipe. If it fails with a NON-retryable status (4xx: bad
 *     model, auth, invalid request) → forward that real status and return null.
 *  2. Transient-failure phase: the gateway/provider is flaking. Open the SSE
 *     stream + heartbeat NOW (client gets HTTP 200 immediately), then keep
 *     retrying the upstream for up to the deadline. The `: keepalive` heartbeat
 *     keeps the connection warm so the client just experiences a slow first
 *     token. On success → return the Response to pipe. If the deadline passes →
 *     emit an SSE error event and return null.
 *
 * Returns the Response to stream, or null when it has already fully handled the
 * response (client error sent, or SSE error emitted + stream ended).
 */
export async function acquireStreamingUpstream(
  res: ExpressResponse,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  // ---- phase 1: quick attempt, headers not sent yet ----
  let quick: Response | null = null
  try {
    quick = await fetchUpstream(url, init)
  } catch {
    quick = null // UpstreamUnreachableError etc. → treat as transient, go to phase 2
  }

  if (quick && quick.ok && quick.body) {
    setSseHeaders(res)
    startKeepalive(res)
    return quick
  }
  if (quick && !quick.ok && !isRetryableStatus(quick.status)) {
    // Genuine client error — preserve the real status; no stream.
    const { status, body } = await readUpstreamError(quick)
    res.status(status).json(body)
    return null
  }

  // ---- phase 2: transient failure — open the stream + heartbeat, then ride it out ----
  setSseHeaders(res)
  startKeepalive(res)
  const good = await fetchUpstreamUntil(url, init, streamDeadlineMs())
  if (good && good.ok && good.body) return good

  let message = "upstream temporarily unavailable, please retry"
  if (good) {
    const { body } = await readUpstreamError(good)
    message = body.error.message
  }
  writeSseData(res, { error: { message, type: "upstream_error" } })
  writeSseDone(res)
  if (!res.writableEnded) res.end()
  return null
}
