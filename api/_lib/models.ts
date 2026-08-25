import { getOpenAIConfig, getAnthropicConfig, type UpstreamCtx } from "./upstream.js"

export type Provider = "openai" | "anthropic"

export interface ModelInfo {
  // Display provider is a free string (openai / anthropic / google / openrouter / …);
  // routing still uses the openai|anthropic `Provider` via getProvider().
  id: string
  provider: string
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

/**
 * Claude models the Netlify AI Gateway serves directly but does NOT expose via
 * any list endpoint (`/v1/models` there returns only the OpenAI catalogue). We
 * add these when an Anthropic upstream is configured on Netlify yet the live
 * probe returns no Claude ids. Source: Netlify AI Gateway "models served
 * directly" list — update when Netlify adds/removes Claude models.
 */
const NETLIFY_DIRECT_ANTHROPIC = [
  "claude-fable-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
]

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
  if (exact) return exact.provider === "anthropic" ? "anthropic" : "openai"
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
  name?: string
  [k: string]: unknown
}

/** One attempted `/models` request — captured so `?debug=1` can explain a miss. */
export interface ProbeDiag {
  source: string
  url: string
  auth: string
  status: number | null
  ok: boolean
  count: number
  error?: string
  bodySnippet?: string
}

/** Extract model ids from whatever list shape an upstream returns (OpenAI `data[]`,
 * Anthropic `data[]`, Gemini `models[].name`, or a bare array). */
function extractIds(json: unknown): string[] {
  const list: RawModel[] = Array.isArray(json)
    ? (json as RawModel[])
    : ((json as { data?: RawModel[]; models?: RawModel[] })?.data ??
        (json as { models?: RawModel[] })?.models ??
        [])
  if (!Array.isArray(list)) return []
  return list
    .map((m) => {
      if (typeof m === "string") return m
      let id = m?.id ?? m?.name
      if (typeof id !== "string") return undefined
      if (id.startsWith("models/")) id = id.slice("models/".length) // Gemini: "models/gemini-.."
      return id
    })
    .filter((id): id is string => Boolean(id))
}

/**
 * A place to look for a model catalogue. Different providers expose it at
 * different paths and want different auth, so each source spells that out.
 */
interface Source {
  name: string
  baseUrl: string
  headers: Record<string, string>
  /** Candidate list paths to try in order; first non-empty wins. */
  paths: string[]
  /** Display provider for ids from this source (overridden by a `vendor/` prefix). */
  provider: string
  /** Keep the full `vendor/model` id (OpenRouter routes by it); default strips it. */
  keepPrefix?: boolean
}

/**
 * GET one candidate URL. Follows Anthropic-style cursor pagination
 * (`has_more` + `last_id`) up to a few pages so large catalogues aren't truncated.
 */
async function probeUrl(source: string, url: string, headers: Record<string, string>): Promise<{ ids: string[]; diag: ProbeDiag }> {
  const auth = headers.authorization ? "bearer" : headers["x-api-key"] ? "x-api-key" : headers["x-goog-api-key"] ? "x-goog-api-key" : "none"
  const diag: ProbeDiag = { source, url, auth, status: null, ok: false, count: 0 }
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

/** Build the provider-specific list-endpoint candidates for a base URL. */
function candidatePaths(baseUrl: string, kind: "openai" | "anthropic" | "gemini" | "openrouter"): string[] {
  const base = baseUrl.replace(/\/+$/, "")
  const hasV1 = /\/v1$/.test(base)
  if (kind === "gemini") return [`${base}/v1beta/models`, `${base}/v1/models`, `${base}/models`]
  return hasV1 ? [`${base}/models`, `${base}/v1/models`] : [`${base}/v1/models`, `${base}/models`]
}

/** Assemble every model source from the resolved upstreams + injected env vars. */
function buildSources(ctx: UpstreamCtx): Source[] {
  const openaiCfg = getOpenAIConfig(ctx)
  const anthropicCfg = getAnthropicConfig(ctx)
  const sources: Source[] = []

  if (openaiCfg.apiKey) {
    sources.push({
      name: "openai",
      baseUrl: openaiCfg.baseUrl,
      headers: { authorization: `Bearer ${openaiCfg.apiKey}` },
      paths: candidatePaths(openaiCfg.baseUrl, "openai"),
      provider: "openai",
    })
  }

  if (anthropicCfg.apiKey) {
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" }
    if (anthropicCfg.gateway) headers.authorization = `Bearer ${anthropicCfg.apiKey}`
    else headers["x-api-key"] = anthropicCfg.apiKey
    sources.push({
      name: "anthropic",
      baseUrl: anthropicCfg.baseUrl,
      headers,
      paths: candidatePaths(anthropicCfg.baseUrl, "anthropic"),
      provider: "anthropic",
    })
  }

  // Gemini — Netlify injects GEMINI_API_KEY + GOOGLE_GEMINI_BASE_URL.
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  const geminiBase = process.env.GOOGLE_GEMINI_BASE_URL ?? process.env.GOOGLE_VERTEX_BASE_URL
  if (geminiKey && geminiBase) {
    sources.push({
      name: "gemini",
      baseUrl: geminiBase,
      headers: { "x-goog-api-key": geminiKey },
      paths: candidatePaths(geminiBase, "gemini"),
      provider: "google",
    })
  }

  // OpenRouter — routes by full `vendor/model` id, so keep the prefix.
  const orKey = process.env.OPENROUTER_API_KEY
  const orBase = process.env.OPENROUTER_BASE_URL
  if (orKey && orBase) {
    sources.push({
      name: "openrouter",
      baseUrl: orBase,
      headers: { authorization: `Bearer ${orKey}` },
      paths: candidatePaths(orBase, "openrouter"),
      provider: "openrouter",
      keepPrefix: true,
    })
  }

  return sources
}

/**
 * Pull the live model catalogue from every configured upstream/provider
 * (OpenAI, Anthropic, Gemini, OpenRouter). Probes run in parallel; within a
 * source the first candidate path that returns ids wins. Duplicate list URLs
 * are probed once. Ids are de-duplicated; `vendor/` prefixes are stripped for
 * routing unless the source needs them. Returns `[]` when nothing responds so
 * the caller can fall back to the static list.
 */
export async function fetchUpstreamModels(
  ctx: UpstreamCtx = {},
): Promise<{ models: ModelInfo[]; probes: ProbeDiag[]; supplementedAnthropic: number }> {
  const sources = buildSources(ctx)
  const probedUrls = new Set<string>()

  const perSource = await Promise.all(
    sources.map(async (src) => {
      const diags: ProbeDiag[] = []
      for (const url of src.paths) {
        if (probedUrls.has(url)) continue
        probedUrls.add(url)
        const { ids, diag } = await probeUrl(src.name, url, src.headers)
        diags.push(diag)
        if (ids.length > 0) return { src, ids, diags }
      }
      return { src, ids: [] as string[], diags }
    }),
  )

  const seen = new Set<string>()
  const models: ModelInfo[] = []
  const probes: ProbeDiag[] = []
  for (const { src, ids, diags } of perSource) {
    probes.push(...diags)
    for (const raw of ids) {
      const stripped = stripProviderPrefix(raw)
      const id = src.keepPrefix ? raw : stripped.id
      if (seen.has(id)) continue
      seen.add(id)
      const provider = stripped.provider ?? src.provider
      models.push({ id, provider, context_window: FALLBACK_MAP.get(id)?.context_window ?? 0 })
    }
  }

  // The Netlify AI Gateway serves Claude but exposes no Claude list endpoint, so
  // supplement from the curated set when an Anthropic upstream is configured yet
  // nothing Claude came back live.
  const hasAnthropicSource = sources.some((s) => s.name === "anthropic")
  const anthropicLive = models.some((m) => m.provider === "anthropic")
  const isNetlifyGateway =
    Boolean(process.env.NETLIFY_AI_GATEWAY_KEY) || sources.some((s) => s.baseUrl.includes("/.netlify/ai"))
  let supplementedAnthropic = 0
  if (hasAnthropicSource && !anthropicLive && isNetlifyGateway) {
    for (const id of NETLIFY_DIRECT_ANTHROPIC) {
      if (seen.has(id)) continue
      seen.add(id)
      models.push({ id, provider: "anthropic", context_window: FALLBACK_MAP.get(id)?.context_window ?? 200_000 })
      supplementedAnthropic++
    }
  }

  return { models, probes, supplementedAnthropic }
}

/** Which credential/base-URL env vars are present + the resolved bases (no secrets). */
function envDiag(ctx: UpstreamCtx) {
  const has = (n: string) => Boolean(process.env[n])
  return {
    resolvedOpenAIBase: getOpenAIConfig(ctx).baseUrl,
    resolvedAnthropicBase: getAnthropicConfig(ctx).baseUrl,
    geminiBase: process.env.GOOGLE_GEMINI_BASE_URL ?? process.env.GOOGLE_VERTEX_BASE_URL ?? null,
    openrouterBase: process.env.OPENROUTER_BASE_URL ?? null,
    netlifyGatewayBase: process.env.NETLIFY_AI_GATEWAY_BASE_URL ?? null,
    keys: {
      AI_INTEGRATIONS_OPENAI: has("AI_INTEGRATIONS_OPENAI_API_KEY"),
      AI_INTEGRATIONS_ANTHROPIC: has("AI_INTEGRATIONS_ANTHROPIC_API_KEY"),
      OPENAI_API_KEY: has("OPENAI_API_KEY"),
      OPENAI_BASE_URL: has("OPENAI_BASE_URL"),
      ANTHROPIC_API_KEY: has("ANTHROPIC_API_KEY"),
      ANTHROPIC_BASE_URL: has("ANTHROPIC_BASE_URL"),
      GEMINI_API_KEY: has("GEMINI_API_KEY") || has("GOOGLE_API_KEY"),
      OPENROUTER_API_KEY: has("OPENROUTER_API_KEY"),
      NETLIFY_AI_GATEWAY_KEY: has("NETLIFY_AI_GATEWAY_KEY"),
    },
  }
}

/**
 * OpenAI-compatible `/v1/models` payload, sourced live from every configured
 * provider. When `debug` is set the payload carries a `_debug` block explaining
 * every probe attempt (source, URL, status, error) plus which env vars are
 * present, so an incomplete list can be diagnosed against the real upstream.
 */
export async function listModels(ctx: UpstreamCtx = {}, opts: { debug?: boolean } = {}) {
  const { models: fetched, probes, supplementedAnthropic } = await fetchUpstreamModels(ctx)
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
  return { data, _debug: { usedFallback, count: data.length, supplementedAnthropic, probes, env: envDiag(ctx) } }
}
