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

/** Fetch a `/models`-style list from one upstream. `path` is appended to baseUrl. */
async function probeModels(
  cfg: UpstreamConfig,
  path: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, { headers, signal: controller.signal })
    if (!res.ok) {
      logger.warn({ status: res.status, origin: cfg.origin, path }, "models probe non-ok")
      return []
    }
    const json = (await res.json()) as { data?: RawModel[]; models?: RawModel[] } | RawModel[]
    const list: RawModel[] = Array.isArray(json) ? json : (json.data ?? json.models ?? [])
    return list.map((m) => (typeof m === "string" ? m : m.id)).filter((id): id is string => Boolean(id))
  } catch (err) {
    logger.warn({ err, origin: cfg.origin, path }, "models probe failed")
    return []
  } finally {
    clearTimeout(timer)
  }
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
export async function fetchUpstreamModels(ctx: UpstreamCtx = {}): Promise<ModelInfo[]> {
  const openaiCfg = getOpenAIConfig(ctx)
  const anthropicCfg = getAnthropicConfig(ctx)

  const probes: Promise<{ ids: string[]; hint?: Provider }>[] = []

  if (openaiCfg.apiKey) {
    probes.push(
      probeModels(openaiCfg, "/models", {
        authorization: `Bearer ${openaiCfg.apiKey}`,
      }).then((ids) => ({ ids })),
    )
  }

  // Skip the Anthropic probe when it resolves to the same unified gateway the
  // OpenAI probe already covers (avoids duplicate work + double listings).
  const sameGateway = openaiCfg.gateway && anthropicCfg.gateway && openaiCfg.apiKey === anthropicCfg.apiKey
  if (anthropicCfg.apiKey && !sameGateway) {
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" }
    if (anthropicCfg.gateway) headers.authorization = `Bearer ${anthropicCfg.apiKey}`
    else headers["x-api-key"] = anthropicCfg.apiKey
    probes.push(probeModels(anthropicCfg, "/v1/models", headers).then((ids) => ({ ids, hint: "anthropic" as const })))
  }

  const results = await Promise.all(probes)

  const seen = new Set<string>()
  const models: ModelInfo[] = []
  for (const { ids, hint } of results) {
    for (const raw of ids) {
      const { id, provider } = stripProviderPrefix(raw)
      if (seen.has(id)) continue
      seen.add(id)
      const resolved = provider ?? hint ?? getProvider(id)
      models.push({ id, provider: resolved, context_window: FALLBACK_MAP.get(id)?.context_window ?? 0 })
    }
  }
  return models
}

/** OpenAI-compatible `/v1/models` payload, sourced live from the upstream. */
export async function listModels(ctx: UpstreamCtx = {}) {
  let models = await fetchUpstreamModels(ctx)
  if (models.length === 0) models = FALLBACK_MODELS
  return models.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 0,
    owned_by: m.provider,
    provider: m.provider,
    ...(m.context_window ? { context_window: m.context_window } : {}),
  }))
}
