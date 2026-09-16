import { Agent as UndiciAgent, ProxyAgent, type Dispatcher } from "undici"
import { logger } from "./logger.js"

/**
 * Optional multi-IP egress. When `UPSTREAM_PROXIES` is set, upstream requests are
 * rotated (round-robin) across a pool of HTTP proxies so the upstream sees many
 * source IPs — useful when the upstream rate-limits / abuse-detects by source IP.
 *
 * By default Netlify self-gateway hosts (`*.netlify.app` / `/.netlify/ai`) are
 * NOT proxied: the gateway is account-keyed, so a proxy can't change an
 * account-level 403/429. BUT Netlify's EDGE also connection-throttles a single
 * datacenter IP under sustained load (TCP handshake ok, TLS/HTTP then stalls) —
 * that IS a source-IP problem, and rotating proxies dodges it. Set
 * `PROXY_NETLIFY_TARGETS=1` (e.g. on a VPS whose IP got edge-throttled) to route
 * the netlify hop through the pool too. Leave unset on the hosted Netlify sites,
 * where proxies aren't present and the call is effectively same-origin.
 *
 * `UPSTREAM_PROXIES` format: one proxy per line or comma-separated, either
 *   host:port:user:pass   (the pipe-list format, `:`-joined)
 *   host:port
 *   http://user:pass@host:port
 * Rotation is per fetch call, so a retry automatically advances to the next
 * proxy — a dead proxy is skipped on the next attempt by the existing retry loop.
 */

const DIRECT = Symbol("direct")

/** Parse one proxy spec into a normalized `http://[user:pass@]host:port` URL. */
function parseSpec(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^(https?|socks5h?):\/\//i.test(s)) return s
  // host:port  or  host:port:user:pass  (from the `a|b|c|d` pipe list, `:`-joined)
  const parts = s.split(":")
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`
  if (parts.length >= 4) {
    const [host, port, user, ...rest] = parts
    const pass = rest.join(":")
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
  }
  return null
}

function parseProxyList(env: string | undefined): string[] {
  if (!env) return []
  return env
    .split(/[\n,]+/)
    .map((x) => parseSpec(x))
    .filter((x): x is string => Boolean(x))
}

interface Pool {
  raw: string
  dispatchers: Dispatcher[]
  labels: string[]
}

let poolCache: Pool | null = null
let rr = 0

/** Direct (no-proxy) dispatcher: shared keep-alive pool. */
const directDispatcher = new UndiciAgent({
  keepAliveTimeout: 60_000,
  connections: 128,
  connect: { timeout: 10_000 },
})

function getPool(): Pool | null {
  const raw = process.env.UPSTREAM_PROXIES
  if (!raw) return null
  if (poolCache && poolCache.raw === raw) return poolCache
  const urls = parseProxyList(raw)
  if (urls.length === 0) {
    poolCache = null
    return null
  }
  const dispatchers = urls.map((u) => new ProxyAgent({ uri: u, connect: { timeout: 10_000 } }))
  // Label = host:port only (never the credentials) for logs/diag.
  const labels = urls.map((u) => {
    try {
      return new URL(u).host
    } catch {
      return "proxy"
    }
  })
  poolCache = { raw, dispatchers, labels }
  logger.info({ proxies: labels.length }, "upstream proxy pool loaded")
  return poolCache
}

/** True when a proxy pool is configured. */
export function proxyPoolSize(): number {
  return getPool()?.dispatchers.length ?? 0
}

/**
 * Pick the dispatcher for the next upstream request. Proxying is skipped for
 * Netlify self-gateway hosts (`*.netlify.app` / `/.netlify/ai`): that upstream
 * is account-keyed, so a proxy can't change its limit and would only add a hop.
 * Returns the chosen dispatcher plus a label (`direct` or `host:port`) for logs.
 */
export function pickDispatcher(targetUrl: string): { dispatcher: Dispatcher; label: string } {
  const pool = getPool()
  if (!pool) return { dispatcher: directDispatcher, label: "direct" }

  let host = ""
  try {
    host = new URL(targetUrl).host
  } catch {
    /* ignore */
  }
  const isNetlify = /\.netlify\.app$/i.test(host) || targetUrl.includes("/.netlify/ai")
  const proxyNetlify = process.env.PROXY_NETLIFY_TARGETS === "1" || process.env.PROXY_NETLIFY_TARGETS === "true"
  if (isNetlify && !proxyNetlify) {
    return { dispatcher: directDispatcher, label: "direct(netlify)" }
  }

  const i = rr++ % pool.dispatchers.length
  return { dispatcher: pool.dispatchers[i], label: pool.labels[i] }
}

export { DIRECT }
