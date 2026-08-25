import { getOpenAIConfig, getAnthropicConfig, type UpstreamConfig, type UpstreamCtx } from "./upstream.js"
import { logger } from "./logger.js"

export type Provider = "openai" | "anthropic"

export interface ModelInfo {
  id: string
  provider: Provider
  context_window: number
}

/**
 * Static fallback list. Only used when NO upstream is configured, or every
 * upstream `/models` probe fails — the live list from the upstream is always
 * preferred so we expose exactly what the upstream actually supports.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  // OpenAI
  { id: "gpt-5.2", provider: "openai", context_window: 400_000 },
  { id: "gpt-5-mini", provider: "openai", context_window: 400_000 },
  { id: "gpt-5-nano", provider: "openai", context_window: 400_000 },
  { id: "o4-mini", provider: "openai", context_window: 200_000 },
  { id: "o3", provider: "openai", context_window: 200_000 },
  // Anthropic
  { id: "claude-opus-4-6", provider: "anthropic", context_window: 200_000 },
  { id: "claude-sonnet-4-6", provider: "anthropic", context_window: 200_000 },
  { id: "claude-haiku-4-5", provider: "anthropic", context_window: 200_000 },
]

const FALLBACK_MAP = new Map(FALLBACK_MODELS.map((m) => [m.id, m]))

/** Known gateway/provider path prefixes emitted by unified gateways (e.g. Vercel
 * returns `anthropic/claude-...`). We strip these so clients get clean ids that
 * route correctly back through this proxy. */
const PROVIDER_PREFIXES: Record<string, Provider | undefined> = {
  openai: "openai",
  anthropic: "anthropic",
  google: undefined,
  vertex: undefined,
  xai: undefined,
  mistral: undefined,
  cohere: undefined,
  groq: undefined,
  perplexity: undefined,
  bedrock: undefined,
  azure: "openai",
  deepseek: undefined,
}

export function getProvider(model: string): Provider {
  const clean = stripProviderPrefix(model).id
  const exact = FALLBACK_MAP.get(clean)
  if (exact) return exact.provider
  // Fallback by prefix
  if (/^claude/i.test(clean)) return "anthropic"
  if (/^(gpt-|o\d|chatgpt)/i.test(clean)) return "openai"
  // Default to OpenAI for unknown ids
  return "openai"
}

/** Split a leading `provider/` segment off a model id, if present. */
function stripProviderPrefix(id: string): { id: string; provider?: Provider } {
  const slash = id.indexOf("/")
  if (slash > 0) {
    const head = id.slice(0, slash).toLowerCase()
    if (head in PROVIDER_PREFIXES) {
      return { id: id.slice(slash + 1), provider: PROVIDER_PREFIXES[head] }
    }
  }
  return { id }
}

interface RawModel {
  id?: string
  [k: string]: unknown
}

/** One attempted `/models` request — captured so `?debug=1` can explain a miss. */
export interface ProbeDiag {
  url: string
  auth: "bearer" | "x-api-key"
  status: number | null
  ok: boolean
  count: number
  error?: string
  bodySnippet?: string
}

/** Extract model ids from whatever list shape an upstream returns. */
function extractIds(json: unknown): string[] {
  const list: RawModel[] = Array.isArray(json)
    ? (json as RawModel[])
    : ((json as { data?: RawModel[]; models?: RawModel[] })?.data ??
        (json as { models?: RawModel[] })?.models ??
        [])
  if (!Array.isArray(list)) return []
  return list.map((m) => (typeof m === "string" ? m : m.id)).filter((id): id is string => Boolean(id))
}

/**
 * GET one candidate `/models` URL. Follows Anthropic-style cursor pagination
 * (`has_more` + `last_id`) up to a few pages so large catalogues aren't truncated.
 */
async function probeUrl(url: string, headers: Record<string, string>): Promise<{ ids: string[]; diag: ProbeDiag }> {
  const auth: ProbeDiag["auth"] = headers.authorization ? "bearer" : "x-api-key"
  const diag: ProbeDiag = { url, auth, status: null, ok: false, count: 0 }
  const ids: string[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < 10; page++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 6000)
      const pagedUrl = cursor ? `${url}${url.includes("?") ? "&" : "?"}limit=1000&after_id=${encodeURIComponent(cursor)}` : url
      let res: Response
      try {
        // Some gateways (notably the Netlify AI Gateway) reject a GET whose
        // Content-Type isn't application/json — send it even though there's no body.
        res = await fetch(pagedUrl, {
          headers: { accept: "application/json", "content-type": "application/json", ...headers },
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      diag.status = res.status
      diag.ok = res.ok
      const text = await res.text()
      if (!res.ok) {
        diag.bodySnippet = text.slice(0, 300)
        break
      }
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        diag.error = "non-JSON response"
        diag.bodySnippet = text.slice(0, 300)
        break
      }
      ids.push(...extractIds(json))
      const more = (json as { has_more?: boolean })?.has_more
      cursor = (json as { last_id?: string })?.last_id ?? null
      if (!more || !cursor) break
    }
  } catch (err) {
    diag.error = err instanceof Error ? err.message : String(err)
  }
  diag.count = ids.length
  return { ids, diag }
}

/**
 * Probe an upstream for its model list, trying the sensible candidate paths for
 * its shape (`/models` and `/v1/models`, with/without a `/v1` base suffix). The
 * first candidate that returns ids wins; all attempts are recorded for debug.
 */
async function probeModels(
  cfg: UpstreamConfig,
  headers: Record<string, string>,
  kind: "openai" | "anthropic",
): Promise<{ ids: string[]; diags: ProbeDiag[] }> {
  const base = cfg.baseUrl.replace(/\/+$/, "")
  const hasV1 = /\/v1$/.test(base)
  const candidates =
    kind === "anthropic"
      ? [hasV1 ? `${base}/models` : `${base}/v1/models`, `${base}/models`]
      : [hasV1 ? `${base}/models` : `${base}/v1/models`, `${base}/v1/models`, `${base}/models`]

  const seen = new Set<string>()
  const diags: ProbeDiag[] = []
  for (const url of candidates) {
    if (seen.has(url)) continue
    seen.add(url)
    const { ids, diag } = await probeUrl(url, headers)
    diags.push(diag)
    if (ids.length > 0) return { ids, diags }
  }
  logger.warn({ origin: cfg.origin, diags }, "models probe found nothing")
  return { ids: [], diags }
}

/**
 * Pull the live model catalogue from whatever upstream(s) are configured:
 *   - OpenAI-format upstream → `GET {base}/models`
 *   - Anthropic upstream     → `GET {base}/v1/messages`-sibling `GET {base}/v1/models`
 *   - Unified gateway (Vercel) → the OpenAI-format probe already returns every
 *     provider's models as `provider/model`, so the Anthropic probe is skipped.
 *
 * Ids are de-duplicated and provider-prefixes stripped. Returns `[]` when nothing
 * could be fetched so the caller can fall back to the static list.
 */
export async function fetchUpstreamModels(
  ctx: UpstreamCtx = {},
): Promise<{ models: ModelInfo[]; probes: ProbeDiag[] }> {
  const openaiCfg = getOpenAIConfig(ctx)
  const anthropicCfg = getAnthropicConfig(ctx)

  const tasks: Promise<{ ids: string[]; diags: ProbeDiag[]; hint?: Provider }>[] = []

  if (openaiCfg.apiKey) {
    tasks.push(probeModels(openaiCfg, { authorization: `Bearer ${openaiCfg.apiKey}` }, "openai"))
  }

  // Skip the Anthropic probe when it resolves to the same endpoint the OpenAI
  // probe already covers — e.g. the Netlify AI Gateway exposes one unified
  // `/v1/models` for every provider, so a second call just repeats it.
  const sameEndpoint = Boolean(openaiCfg.apiKey) && anthropicCfg.baseUrl === openaiCfg.baseUrl
  if (anthropicCfg.apiKey && !sameEndpoint) {
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" }
    if (anthropicCfg.gateway) headers.authorization = `Bearer ${anthropicCfg.apiKey}`
    else headers["x-api-key"] = anthropicCfg.apiKey
    tasks.push(probeModels(anthropicCfg, headers, "anthropic").then((r) => ({ ...r, hint: "anthropic" as const })))
  }

  const results = await Promise.all(tasks)

  const seen = new Set<string>()
  const models: ModelInfo[] = []
  const probes: ProbeDiag[] = []
  for (const { ids, diags, hint } of results) {
    probes.push(...diags)
    for (const raw of ids) {
      const { id, provider } = stripProviderPrefix(raw)
      if (seen.has(id)) continue
      seen.add(id)
      const resolved = provider ?? hint ?? getProvider(id)
      models.push({ id, provider: resolved, context_window: FALLBACK_MAP.get(id)?.context_window ?? 0 })
    }
  }
  return { models, probes }
}

/**
 * OpenAI-compatible `/v1/models` payload, sourced live from the upstream. When
 * `debug` is set the payload carries a `_debug` block explaining every probe
 * attempt (URL, status, error) so an incomplete list can be diagnosed.
 */
export async function listModels(ctx: UpstreamCtx = {}, opts: { debug?: boolean } = {}) {
  const { models: fetched, probes } = await fetchUpstreamModels(ctx)
  const usedFallback = fetched.length === 0
  const models = usedFallback ? FALLBACK_MODELS : fetched
  const data = models.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 0,
    owned_by: m.provider,
    provider: m.provider,
    ...(m.context_window ? { context_window: m.context_window } : {}),
  }))
  if (!opts.debug) return { data }
  return { data, _debug: { usedFallback, count: data.length, probes } }
}
