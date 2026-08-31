import { redactUrls, redactDeep, describeFetchError } from "./redact.js"
import { logger } from "./logger.js"

/** Host for logging (server-side only; safe to include the real host). */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "?"
  }
}

const VERCEL_GATEWAY_BASE = "https://ai-gateway.vercel.sh"

export interface UpstreamConfig {
  baseUrl: string
  apiKey: string
  /** True when the upstream is a multi-provider AI Gateway (Vercel / Netlify).
   * In this mode model ids are sent as `provider/model` and Bearer auth is used. */
  gateway: boolean
  /** Human-readable origin name (used in error messages and logs). */
  origin: "openai" | "anthropic" | "vercel-ai-gateway" | "netlify-ai-gateway"
  /** True only when the base URL is the official provider host
   * (api.openai.com / api.anthropic.com). Non-native upstreams (gateways,
   * distributors, custom bases) often reject beta/unknown request fields, so
   * those get sanitized before forwarding. */
  native: boolean
}

function trimSlash(s: string) {
  return s.replace(/\/+$/, "")
}

/** Does `baseUrl` point at the provider's official API host? */
function isNativeHost(baseUrl: string, provider: "openai" | "anthropic"): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return provider === "openai"
      ? /(^|\.)api\.openai\.com$/.test(host)
      : /(^|\.)api\.anthropic\.com$/.test(host)
  } catch {
    return false
  }
}

/** Per-request context the upstream resolver needs (currently just the
 * `x-vercel-oidc-token` request header that Vercel injects on each
 * function invocation). */
export interface UpstreamCtx {
  oidcToken?: string
}

/** Pull the OIDC token Vercel attaches to each function invocation. In
 * Functions runtime this lives ONLY on the request header, NOT in env. */
export function readOidcToken(req: {
  headers: Record<string, unknown> | NodeJS.Dict<string | string[]>
}): string {
  const headers = req.headers as Record<string, string | string[] | undefined>
  const raw = headers["x-vercel-oidc-token"]
  if (!raw) return ""
  return Array.isArray(raw) ? (raw[0] ?? "") : raw
}

/**
 * Resolve the multi-provider gateway credential + base URL. Order of preference:
 *   1. `AI_GATEWAY_API_KEY` (Vercel, explicit)
 *   2. `NETLIFY_AI_GATEWAY_KEY` + `NETLIFY_AI_GATEWAY_BASE_URL` (Netlify, always injected on AI-enabled sites)
 *   3. `VERCEL_OIDC_TOKEN` env var (build/dev only)
 *   4. `x-vercel-oidc-token` request header (Vercel Functions runtime, zero-config)
 *
 * The Vercel gateway and the OIDC token both target `ai-gateway.vercel.sh`.
 * Netlify injects its own gateway base URL, so the key MUST travel with that
 * URL — never with the Vercel default. Returns null when no gateway is available.
 */
function resolveGateway(ctx: UpstreamCtx): { baseUrl: string; apiKey: string; origin: UpstreamConfig["origin"] } | null {
  const vercelKey = process.env.AI_GATEWAY_API_KEY
  if (vercelKey) {
    return { baseUrl: VERCEL_GATEWAY_BASE, apiKey: vercelKey, origin: "vercel-ai-gateway" }
  }
  const netlifyKey = process.env.NETLIFY_AI_GATEWAY_KEY
  const netlifyBase = process.env.NETLIFY_AI_GATEWAY_BASE_URL
  if (netlifyKey && netlifyBase) {
    return { baseUrl: trimSlash(netlifyBase), apiKey: netlifyKey, origin: "netlify-ai-gateway" }
  }
  const oidc = process.env.VERCEL_OIDC_TOKEN ?? ctx.oidcToken
  if (oidc) {
    return { baseUrl: VERCEL_GATEWAY_BASE, apiKey: oidc, origin: "vercel-ai-gateway" }
  }
  return null
}

/**
 * Resolve the OpenAI-format upstream. Order: explicit override → platform-injected → gateway fallback.
 *
 * The key and the base URL are always taken from the SAME source so a gateway
 * key is never sent to `api.openai.com` (and vice versa):
 *   1. `AI_INTEGRATIONS_OPENAI_*` (v0-injected pair)
 *   2. `OPENAI_API_KEY` + `OPENAI_BASE_URL` (standard SDK vars; Netlify injects both on AI-enabled sites)
 *   3. gateway (`/v1` suffix; models sent as `provider/model`)
 */
export function getOpenAIConfig(ctx: UpstreamCtx = {}): UpstreamConfig {
  const v0Key = process.env.AI_INTEGRATIONS_OPENAI_API_KEY
  if (v0Key) {
    const baseUrl = trimSlash(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1")
    return { baseUrl, apiKey: v0Key, gateway: false, origin: "openai", native: isNativeHost(baseUrl, "openai") }
  }
  const sdkKey = process.env.OPENAI_API_KEY
  if (sdkKey) {
    // Netlify's injected OPENAI_BASE_URL is a per-provider, OpenAI-compatible
    // endpoint: plain model ids, Bearer auth. So it is a DIRECT upstream, not a
    // `provider/model` unified gateway — gateway stays false.
    const baseUrl = trimSlash(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
    return { baseUrl, apiKey: sdkKey, gateway: false, origin: "openai", native: isNativeHost(baseUrl, "openai") }
  }
  const gw = resolveGateway(ctx)
  if (gw) {
    return { baseUrl: `${gw.baseUrl}/v1`, apiKey: gw.apiKey, gateway: true, origin: gw.origin, native: false }
  }
  return { baseUrl: "https://api.openai.com/v1", apiKey: "", gateway: false, origin: "openai", native: true }
}

/**
 * Resolve the Anthropic-format upstream. Same override → platform → gateway order.
 *   1. `AI_INTEGRATIONS_ANTHROPIC_*` (v0-injected pair)
 *   2. `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` (standard SDK vars; Netlify injects both)
 *   3. gateway (no `/v1` suffix — the Messages route appends `/v1/messages`)
 */
export function getAnthropicConfig(ctx: UpstreamCtx = {}): UpstreamConfig {
  const v0Key = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
  if (v0Key) {
    const baseUrl = trimSlash(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
    return { baseUrl, apiKey: v0Key, gateway: false, origin: "anthropic", native: isNativeHost(baseUrl, "anthropic") }
  }
  const sdkKey = process.env.ANTHROPIC_API_KEY
  if (sdkKey) {
    // Netlify's injected ANTHROPIC_BASE_URL speaks the native Anthropic protocol
    // (x-api-key, /v1/messages) — a direct upstream, not a unified gateway.
    const baseUrl = trimSlash(process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
    return { baseUrl, apiKey: sdkKey, gateway: false, origin: "anthropic", native: isNativeHost(baseUrl, "anthropic") }
  }
  const gw = resolveGateway(ctx)
  if (gw) {
    return { baseUrl: gw.baseUrl, apiKey: gw.apiKey, gateway: true, origin: gw.origin, native: false }
  }
  return { baseUrl: "https://api.anthropic.com", apiKey: "", gateway: false, origin: "anthropic", native: true }
}

/**
 * Top-level Anthropic Messages fields that only the official API accepts. Strict
 * non-native upstreams (gateways, distributors) reject unknown fields with
 * `400 ... Extra inputs are not permitted`, so we drop these before forwarding
 * to a non-native upstream. Extend as new beta fields surface.
 */
const NON_NATIVE_UNSUPPORTED_FIELDS = ["context_management"] as const

/**
 * Return a copy of an Anthropic Messages body safe to send to `cfg`. Native
 * Anthropic gets the body untouched; non-native upstreams get beta-only fields
 * stripped so a newer client (e.g. one sending `context_management`) doesn't
 * hard-fail against an upstream that hasn't added those fields yet.
 */
export function sanitizeAnthropicBody<T extends Record<string, unknown>>(body: T, cfg: UpstreamConfig): T {
  if (cfg.native) return body
  let out: T | null = null
  for (const field of NON_NATIVE_UNSUPPORTED_FIELDS) {
    if (field in body) {
      out = out ?? { ...body }
      delete (out as Record<string, unknown>)[field]
    }
  }
  return out ?? body
}

/** Transient upstream statuses worth retrying before any bytes reach the client. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
/** Cap any single backoff so retries can't blow the serverless function's time limit. */
const MAX_RETRY_WAIT_MS = 2000
/** Abort a request that hasn't produced RESPONSE HEADERS within this window and
 * retry it — turns a hung gateway→provider connection into a fast retry instead
 * of a request that hangs until the function times out. Cleared the moment
 * headers arrive, so a legitimately slow stream/generation is never cut. */
const RESPONSE_TIMEOUT_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Backoff for one attempt (with jitter to de-sync concurrent retries). For 429
 * honor `Retry-After` (secs or HTTP-date), capped. */
function backoffMs(res: Response, attempt: number): number {
  const jitter = Math.floor(Math.random() * 150)
  if (res.status === 429) {
    const h = res.headers.get("retry-after")
    if (h) {
      const secs = Number(h)
      if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1000, MAX_RETRY_WAIT_MS)
      const when = Date.parse(h)
      if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), MAX_RETRY_WAIT_MS)
    }
    return Math.min(500 * (attempt + 1) + jitter, MAX_RETRY_WAIT_MS)
  }
  return Math.min(300 * (attempt + 1) + jitter, MAX_RETRY_WAIT_MS)
}

/** Thrown when the request to the upstream itself never completed (network
 * error / hang) after all retries — distinct from the upstream returning an
 * error response. Lets the error handlers reply 502 with a clear, retryable
 * message instead of a generic 500, and tells us the failing hop is
 * us↔gateway (not gateway↔provider). */
export class UpstreamUnreachableError extends Error {
  readonly attempts: number
  constructor(message: string, attempts: number) {
    super(message)
    this.name = "UpstreamUnreachableError"
    this.attempts = attempts
  }
}

/**
 * `fetch` for the initial upstream request with retry on TRANSIENT failures
 * (network throw like "fetch failed", a 5xx, a 429 rate-limit, or a pre-response
 * hang) — these happen at the gateway→provider hop before any response is
 * produced, so retrying is safe: no tokens were generated, nothing was streamed
 * to the client. Each attempt is aborted if no response headers arrive within
 * RESPONSE_TIMEOUT_MS, then retried. 429 honors `Retry-After` (bounded). 4xx
 * other than 429 (bad model, auth, invalid request) is NOT retried. Only use
 * this for the first request; never retry once a stream has started.
 */
export async function fetchUpstream(url: string, init: RequestInit, retries = 4): Promise<Response> {
  const host = hostOf(url)
  let lastErr: unknown
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error("upstream response timeout")), RESPONSE_TIMEOUT_MS)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { ...init, signal: ac.signal })
      // Headers received — stop the timer so a slow stream/generation body is
      // never cut, and hand the response to the caller.
      clearTimeout(timer)
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        logger.warn({ host, status: res.status, attempt, ms: Date.now() - t0 }, "upstream retryable status")
        await delay(backoffMs(res, attempt))
        continue
      }
      return res
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      logger.warn({ host, attempt, ms: Date.now() - t0, err: describeFetchError(err) }, "upstream attempt failed")
      if (attempt < retries) {
        await delay(Math.min(300 * (attempt + 1) + Math.floor(Math.random() * 150), MAX_RETRY_WAIT_MS))
        continue
      }
      throw new UpstreamUnreachableError(
        `upstream unreachable after ${retries + 1} attempts: ${describeFetchError(lastErr)}`,
        retries + 1,
      )
    }
  }
}

/** Is this status one we treat as a transient, retryable upstream failure? */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status)
}

export interface RideOutResult {
  res: Response | null
  attempts: number
  elapsedMs: number
  /** describeFetchError of the last failure (network throw or retryable status). */
  lastError?: string
}

/**
 * Keep hitting the upstream until it yields a usable (ok + body) response, a
 * NON-retryable status (e.g. 4xx — hand it back so the caller forwards it), or
 * `deadlineMs` elapses. Never throws and never gives up early on transient
 * failures — this is what lets a streaming caller ride out a multi-second
 * gateway/provider outage behind a heartbeat instead of surfacing a 500.
 * Returns the Response in `res`, or `res: null` if it kept failing transiently
 * past the deadline, along with attempt/elapsed/lastError diagnostics.
 */
/** A sustained 429 is account-level rate limiting, not a recoverable blip. Retry
 * only a few times for transient spikes, then FORWARD the 429 to the client
 * (with its Retry-After) so it can back off / fail over — far better than burning
 * the whole deadline and returning a less-actionable 502. */
const MAX_429_RETRIES = 2

export async function fetchUpstreamUntil(url: string, init: RequestInit, deadlineMs: number): Promise<RideOutResult> {
  const host = hostOf(url)
  const start = Date.now()
  let lastError: string | undefined
  let attempts = 0
  let rateLimitHits = 0
  // Last retryable HTTP response (429/5xx) kept so we can forward it on give-up
  // instead of throwing a generic 502. Only network throws leave this null.
  let lastRetryableRes: Response | null = null
  const supersede = (res: Response | null) => {
    if (lastRetryableRes && lastRetryableRes !== res) {
      try {
        void lastRetryableRes.body?.cancel()
      } catch {
        /* ignore */
      }
    }
    lastRetryableRes = res
  }
  for (let attempt = 0; ; attempt++) {
    attempts = attempt + 1
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error("upstream response timeout")), RESPONSE_TIMEOUT_MS)
    const t0 = Date.now()
    try {
      const res = await fetch(url, { ...init, signal: ac.signal })
      clearTimeout(timer)
      if (res.ok && res.body) return { res, attempts, elapsedMs: Date.now() - start }
      if (!RETRYABLE_STATUS.has(res.status)) return { res, attempts, elapsedMs: Date.now() - start } // 4xx → forward
      lastError = `status ${res.status}`
      logger.warn({ host, status: res.status, attempt, ms: Date.now() - t0 }, "upstream retryable status")
      supersede(res)
      if (res.status === 429 && ++rateLimitHits > MAX_429_RETRIES) {
        // Sustained rate limit — stop retrying, forward the 429 as-is.
        return { res: lastRetryableRes, attempts, elapsedMs: Date.now() - start, lastError }
      }
    } catch (err) {
      clearTimeout(timer)
      lastError = describeFetchError(err)
      logger.warn({ host, attempt, ms: Date.now() - t0, err: lastError }, "upstream attempt failed")
    }
    if (Date.now() - start >= deadlineMs) {
      // Forward the last 429/5xx if we have one; only pure network failures give null.
      return { res: lastRetryableRes, attempts, elapsedMs: Date.now() - start, lastError }
    }
    await delay(Math.min(700 * (attempt + 1) + Math.floor(Math.random() * 400), 2500))
  }
}

/** Pull just message/type/code out of whatever error shape the upstream sent,
 * dropping every other field (user_id, request_id, provider, org, …) so no
 * channel/account metadata is forwarded. The message is URL/host-redacted. */
function buildErrorBody(json: unknown, raw: string): { error: { message: string; type: string; code?: unknown } } {
  const root = (json ?? {}) as Record<string, unknown>
  const inner = (root.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root) as Record<
    string,
    unknown
  >
  const rawMessage =
    (typeof inner.message === "string" && inner.message) ||
    (typeof root.message === "string" && root.message) ||
    raw ||
    "upstream error"
  const type = (typeof inner.type === "string" && inner.type) || (typeof root.type === "string" && root.type) || "upstream_error"
  const code = inner.code ?? root.code
  const error: { message: string; type: string; code?: unknown } = { message: redactUrls(String(rawMessage)), type: String(type) }
  if (code !== undefined) error.code = code
  return { error }
}

/**
 * Read an upstream error response safely (text first, then optional JSON parse)
 * and return a sanitized `body` safe to forward: only message/type/code, with
 * URLs/hosts redacted from the message. `raw` is kept (also redacted) for
 * server-side logging only — do NOT send it to the client.
 */
export async function readUpstreamError(
  response: Response,
): Promise<{ status: number; raw: string; body: { error: { message: string; type: string; code?: unknown } } }> {
  let raw = ""
  try {
    raw = await response.text()
  } catch {
    raw = ""
  }
  let json: unknown
  if (raw) {
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
  }
  return { status: response.status, raw: redactUrls(raw), body: buildErrorBody(json, raw) }
}
