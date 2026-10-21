import { getOpenAIConfigChain, getAnthropicConfigChain, type UpstreamCtx } from "./upstream.js"

/**
 * Build the `/healthz` payload from the SAME resolver requests use, so the
 * reported availability can never drift from what actually happens on a call.
 * Shared by the Express app (Vercel/local) and the Netlify Function.
 * Public endpoint: availability only — which origin/gateway serves is the
 * channel we don't disclose.
 */
export function buildHealth(ctx: UpstreamCtx = {}) {
  const openai = getOpenAIConfigChain(ctx)[0]
  const anthropic = getAnthropicConfigChain(ctx)[0]
  return {
    status: "ok" as const,
    upstream: {
      openai: Boolean(openai.apiKey),
      anthropic: Boolean(anthropic.apiKey),
    },
  }
}
