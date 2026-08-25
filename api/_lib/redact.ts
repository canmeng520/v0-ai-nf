/**
 * Strip anything that would reveal the upstream channel/endpoint from text that
 * is sent back to a client (forwarded upstream errors, stream error events, the
 * 500 handler message). We never want a caller to learn which distributor,
 * gateway, or host actually served — only that "an upstream" failed.
 */

// Absolute http(s) URLs.
const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]}]+/gi
// Bare host:port and IPv4(:port) — catches endpoints quoted without a scheme.
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g

export function redactUrls(text: string): string {
  if (!text) return text
  return text.replace(URL_RE, "[redacted-upstream]").replace(IPV4_RE, "[redacted-upstream]")
}

/** Recursively redact URLs/hosts in every string of a JSON-ish value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactUrls(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v)
    return out as unknown as T
  }
  return value
}

/** Redact an Error's message (or any thrown value coerced to string). */
export function redactErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return redactUrls(msg)
}
