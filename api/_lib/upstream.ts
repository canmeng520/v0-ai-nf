import { redactUrls, redactDeep } from "./redact.js"

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
const RETRYABLE_STATUS = new Set([500, 502, 503, 504])

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `fetch` for the initial upstream request with a small retry on TRANSIENT
 * failures (network throw like "fetch failed", or a 5xx from the gateway) —
 * these happen at the gateway→provider hop before any response is produced, so
 * retrying is safe: no tokens were generated, nothing was streamed to the
 * client. 4xx (bad model, auth, invalid request) is NOT retried. Only use this
 * for the first request; never retry once a stream has started.
 */
export async function fetchUpstream(url: string, init: RequestInit, retries = 2): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init)
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        await delay(300 * (attempt + 1))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await delay(300 * (attempt + 1))
        continue
      }
      throw lastErr
    }
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
