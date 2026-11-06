/**
 * Per-request context that follows a request through every async hop, so the
 * one place all upstream calls go through (upstreamFetch) can tag them.
 *
 * The gateway entry (lb) stamps each request with its usage record id
 * (`x-usage-id`). Calls to the local account pool carry it on, and the pool
 * writes back which account served the request.
 */
import { AsyncLocalStorage } from "node:async_hooks"

interface Ctx {
  usageId?: string
}

const store = new AsyncLocalStorage<Ctx>()

/** Run `fn` with the context of an incoming request (headers already lower-cased). */
export function withRequestContext<T>(headers: Record<string, unknown>, fn: () => T): T {
  const id = headers["x-usage-id"]
  const usageId = typeof id === "string" && /^\d{1,15}$/.test(id) ? id : undefined
  return store.run({ usageId }, fn)
}

/** Headers to add to a call to the local pool (never to a real upstream). */
export function poolHeaders(url: string): Record<string, string> {
  const ctx = store.getStore()
  if (!ctx?.usageId) return {}
  try {
    const h = new URL(url).hostname
    if (h !== "127.0.0.1" && h !== "localhost") return {}
  } catch {
    return {}
  }
  return { "x-usage-id": ctx.usageId }
}
