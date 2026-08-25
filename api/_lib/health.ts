import { getOpenAIConfig, getAnthropicConfig, type UpstreamCtx } from "./upstream.js"

/**
 * Build the `/healthz` payload from the SAME resolver requests use, so the
 * reported availability can never drift from what actually happens on a call.
 * Shared by the Express app (Vercel/local) and the Netlify Function.
 */
export function buildHealth(ctx: UpstreamCtx = {}) {
  const openai = getOpenAIConfig(ctx)
  const anthropic = getAnthropicConfig(ctx)
  const hasGatewayKey = Boolean(process.env.AI_GATEWAY_API_KEY)
  const hasNetlifyGateway = Boolean(process.env.NETLIFY_AI_GATEWAY_KEY && process.env.NETLIFY_AI_GATEWAY_BASE_URL)
  const hasOidcEnv = Boolean(process.env.VERCEL_OIDC_TOKEN)
  const hasOidcHeader = Boolean(ctx.oidcToken)

  return {
    status: "ok" as const,
    upstream: {
      openai: Boolean(openai.apiKey),
      anthropic: Boolean(anthropic.apiKey),
    },
    origin: {
      openai: openai.origin,
      anthropic: anthropic.origin,
    },
    gateway: {
      vercelKey: hasGatewayKey,
      netlify: hasNetlifyGateway,
      oidcEnv: hasOidcEnv,
      oidcHeader: hasOidcHeader,
    },
  }
}
