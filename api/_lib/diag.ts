import { getOpenAIConfig, getAnthropicConfig, type UpstreamCtx } from "./upstream.js"
import { envDiag } from "./models.js"
import { describeFetchError } from "./redact.js"

/**
 * On-demand live probe of the upstream — fires the SAME request the hot path
 * uses (same host/path/auth) N times at a given concurrency, and reports each
 * attempt's outcome plus a by-error-code histogram. This is how we locate a
 * transient `fetch failed` on the deployed site without redeploy-per-hypothesis:
 * `GET /v1/diag?provider=anthropic&model=claude-opus-5&stream=true&n=20&concurrency=20`.
 *
 * Auth-gated by the caller. URLs/hosts are masked in the output; the actionable
 * signal is `summary.byError` (ECONNRESET / UND_ERR_CONNECT_TIMEOUT / DNS / …).
 */

const PER_ATTEMPT_TIMEOUT_MS = 30_000

type Params = Record<string, string | string[] | undefined>

function str(p: Params, k: string): string | undefined {
  const v = p[k]
  return Array.isArray(v) ? v[0] : v
}
function int(p: Params, k: string, dflt: number, max: number): number {
  const v = Number(str(p, k))
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : dflt
}

/** Keep the path but mask a non-netlify host so a private distributor isn't leaked. */
function maskBase(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    if (/\.netlify\.app$/i.test(u.hostname)) return `<self>.netlify.app${u.pathname}`
    if (/(^|\.)api\.(openai|anthropic)\.com$/i.test(u.hostname)) return `${u.hostname}${u.pathname}`
    return `<redacted-host>${u.pathname}`
  } catch {
    return "<invalid-base>"
  }
}

interface Attempt {
  i: number
  ok: boolean
  status?: number
  error?: string
  ms: number
}

async function probeOnce(i: number, url: string, init: RequestInit): Promise<Attempt> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error("timeout")), PER_ATTEMPT_TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    clearTimeout(timer)
    // Drain a little so the connection completes like the real path would.
    try {
      await res.body?.cancel()
    } catch {
      /* ignore */
    }
    return { i, ok: res.ok, status: res.status, ms: Date.now() - t0 }
  } catch (err) {
    clearTimeout(timer)
    return { i, ok: false, error: describeFetchError(err), ms: Date.now() - t0 }
  }
}

/** Run `n` probes with at most `concurrency` in flight. */
async function runPool(n: number, concurrency: number, task: (i: number) => Promise<Attempt>): Promise<Attempt[]> {
  const results: Attempt[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, n) }, async () => {
    for (;;) {
      const i = next++
      if (i >= n) return
      results.push(await task(i))
    }
  })
  await Promise.all(workers)
  return results.sort((a, b) => a.i - b.i)
}

export async function runDiag(ctx: UpstreamCtx, params: Params) {
  const provider = str(params, "provider") === "openai" ? "openai" : "anthropic"
  const model = str(params, "model") ?? (provider === "openai" ? "gpt-5.2" : "claude-opus-5")
  const stream = str(params, "stream") === "true" || str(params, "stream") === "1"
  const n = int(params, "n", 3, 30)
  const concurrency = int(params, "concurrency", n, 20)

  const cfg = provider === "openai" ? getOpenAIConfig(ctx) : getAnthropicConfig(ctx)
  if (!cfg.apiKey) {
    return { error: `${provider} upstream is not configured`, env: envDiag(ctx) }
  }

  let url: string
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (provider === "openai") {
    url = `${cfg.baseUrl}/chat/completions`
    headers.authorization = `Bearer ${cfg.apiKey}`
  } else {
    url = `${cfg.baseUrl}/v1/messages`
    headers["anthropic-version"] = "2023-06-01"
    if (cfg.gateway) headers.authorization = `Bearer ${cfg.apiKey}`
    else headers["x-api-key"] = cfg.apiKey
  }
  const outModel = cfg.gateway ? `${provider}/${model}` : model
  const body = JSON.stringify({
    model: outModel,
    max_tokens: 8,
    stream,
    messages: [{ role: "user", content: "ping" }],
  })
  const init: RequestInit = { method: "POST", headers, body }

  const attempts = await runPool(n, concurrency, (i) => probeOnce(i, url, init))

  const byError: Record<string, number> = {}
  let ok = 0
  const durations: number[] = []
  for (const a of attempts) {
    durations.push(a.ms)
    if (a.ok) ok++
    else {
      const key = a.error ?? (a.status ? `status ${a.status}` : "unknown")
      byError[key] = (byError[key] ?? 0) + 1
    }
  }
  durations.sort((x, y) => x - y)
  const p50 = durations.length ? durations[Math.floor(durations.length / 2)] : 0

  return {
    target: { provider, model: outModel, stream, baseMasked: maskBase(cfg.baseUrl), gateway: cfg.gateway, native: cfg.native, origin: cfg.origin },
    summary: { n, concurrency, ok, fail: n - ok, byError, msP50: p50, msMax: durations[durations.length - 1] ?? 0 },
    attempts,
    env: envDiag(ctx),
  }
}
