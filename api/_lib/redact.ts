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

// Whole messages that only make sense for the channel behind us: replace them
// with our own wording.
const REWRITES: Array<[RegExp, string]> = [
  // Hosting platform 404 page ("Not Found - Request ID: 01M5… Build and deploy your own site…").
  [/^\s*Not Found - Request ID[\s\S]*$/i, "The upstream service is temporarily unavailable. Please retry."],
  // Provider moderation text with its help-center link and request id.
  [/^\s*Your request was rejected by the safety system[\s\S]*$/i, "Your request was rejected by the content safety system. Please modify the prompt and try again."],
]
// Fingerprints that can appear inside otherwise useful messages.
const REQ_ID_RE = /\s*-?\s*Request ID:?\s*(?:req_)?[0-9A-Za-z_]{16,}\.?/gi
const PROMO_RE = /\s*Build and deploy your own site for free:?[^\n]*/gi
const CONTACT_RE = /\s*(?:If you believe this is an error, )?contact us(?: at [^\s.,]+(?:\.[^\s.,]+)*)?(?: and include[^.]*)?\.?/gi
const HOST_RE = /\b(?:[\w-]+\.)*(?:openai\.com|netlify\.(?:app|com|new))\b/gi
const PLATFORM_RE = /\bnetlify(?:-[a-z]+)*\b/gi

export function redactUrls(text: string): string {
  if (!text) return text
  for (const [re, msg] of REWRITES) if (re.test(text)) return msg
  return text
    .replace(URL_RE, "[redacted-upstream]")
    .replace(IPV4_RE, "[redacted-upstream]")
    .replace(REQ_ID_RE, "")
    .replace(PROMO_RE, "")
    .replace(CONTACT_RE, "")
    .replace(HOST_RE, "[redacted-upstream]")
    .replace(PLATFORM_RE, "upstream")
    .trimEnd()
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

/**
 * Describe a thrown fetch/network error with its real cause code appended, e.g.
 * `fetch failed [ECONNRESET]`. `fetch failed` is undici's generic wrapper; the
 * actionable detail (connection reset / connect timeout / DNS) lives on
 * `err.cause.code`. The message is URL/host-redacted.
 */
export function describeFetchError(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } }
  const base = redactUrls(String(e?.message ?? err ?? "error"))
  const code = e?.cause?.code ?? e?.code
  const causeMsg = !code && e?.cause?.message ? redactUrls(e.cause.message) : undefined
  if (code) return `${base} [${code}]`
  if (causeMsg && causeMsg !== base) return `${base} (${causeMsg})`
  return base
}
