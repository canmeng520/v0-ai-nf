const GATEWAY_BASE = "https://ai-gateway.vercel.sh"

export interface UpstreamConfig {
  baseUrl: string
  apiKey: string
  /** True when the upstream is the Vercel AI Gateway. In this mode model
   * ids must be sent as `provider/model` and Bearer auth is preferred. */
  gateway: boolean
  /** Human-readable origin name (used in error messages and logs). */
  origin: "openai" | "anthropic" | "vercel-ai-gateway"
}

function trimSlash(s: string) {
  return s.replace(/\/+$/, "")
}

/** Per-request context the upstream resolver needs (currently just the
 * `x-vercel-oidc-token` request header that Vercel injects on each
 * function invocation). */
export interface UpstreamCtx {
  oidcToken?: string
}

/** Pull the OIDC token Vercel attaches to each function invocation. In
 * Functions runtime this lives ONLY on the request header, NOT in env. */
export function readOidcToken(req: { headers: Record<string, unknown> | NodeJS.Dict<string | string[]> }): string {
  const headers = req.headers as Record<string, string | string[] | undefined>
  const raw = headers["x-vercel-oidc-token"]
  if (!raw) return ""
  return Array.isArray(raw) ? (raw[0] ?? "") : raw
}

/**
 * Resolve the AI Gateway credential. Order of preference:
 *   1. `AI_GATEWAY_API_KEY` env var (explicit)
 *   2. `VERCEL_OIDC_TOKEN` env var (build/dev only)
 *   3. `x-vercel-oidc-token` request header (Vercel Functions runtime, zero-config)
 * All three are accepted as `Authorization: Bearer <token>` by the gateway.
 */
function gatewayCredential(ctx: UpstreamCtx): string {
  return process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN ?? ctx.oidcToken ?? ""
}

export function getOpenAIConfig(ctx: UpstreamCtx = {}): UpstreamConfig {
  const overrideKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (overrideKey) {
    const baseUrl = trimSlash(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ?? "https://api.openai.com/v1")
    return { baseUrl, apiKey: overrideKey, gateway: false, origin: "openai" }
  }
  const gw = gatewayCredential(ctx)
  if (gw) {
    return { baseUrl: `${GATEWAY_BASE}/v1`, apiKey: gw, gateway: true, origin: "vercel-ai-gateway" }
  }
  return { baseUrl: "https://api.openai.com/v1", apiKey: "", gateway: false, origin: "openai" }
}

export function getAnthropicConfig(ctx: UpstreamCtx = {}): UpstreamConfig {
  const overrideKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY
  if (overrideKey) {
    const baseUrl = trimSlash(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
    return { baseUrl, apiKey: overrideKey, gateway: false, origin: "anthropic" }
  }
  const gw = gatewayCredential(ctx)
  if (gw) {
    return { baseUrl: GATEWAY_BASE, apiKey: gw, gateway: true, origin: "vercel-ai-gateway" }
  }
  return { baseUrl: "https://api.anthropic.com", apiKey: "", gateway: false, origin: "anthropic" }
}

/** Read an upstream error response safely (text first, then optional JSON parse). */
export async function readUpstreamError(
  response: Response,
): Promise<{ status: number; raw: string; json: unknown }> {
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
  return { status: response.status, raw, json }
}
