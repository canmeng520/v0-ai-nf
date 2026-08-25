# AI Proxy Gateway

A unified Bearer-authenticated gateway that exposes both OpenAI and Anthropic models through a single base URL. Built as a pnpm monorepo:

- `apps/api` — Express 5 + TypeScript proxy (port `8787`)
- `apps/web` — Vite + React 19 documentation site (port `3000`, proxies `/api` and `/v1` to the API)

## Features

- `GET /api/healthz` — public health check
- `GET /v1/models` — lists the models the configured upstream actually supports, pulled live from the upstream's own `/models` endpoint (Bearer required; falls back to a static list only when no upstream responds)
- `POST /v1/chat/completions` — OpenAI-compatible Chat Completions
  - OpenAI models pass through; Anthropic models are auto-converted both ways
- `POST /v1/messages` — Anthropic-compatible Messages
  - Anthropic models pass through; OpenAI models are auto-converted both ways
- Full SSE streaming support with a `: keepalive` heartbeat every 5 seconds
- Bearer token (`Authorization: Bearer …`) or `x-api-key` auth, default token `123`
- Tool calling and (Anthropic) thinking parameters preserved across conversions
- 50 MB request body limit
- Safe upstream error reading (`response.text()` first, then `JSON.parse`)

## Environment

Copy `.env.example` to `.env` and set:

```
PROXY_API_KEY=123
AI_INTEGRATIONS_OPENAI_BASE_URL=
AI_INTEGRATIONS_OPENAI_API_KEY=
AI_INTEGRATIONS_ANTHROPIC_BASE_URL=
AI_INTEGRATIONS_ANTHROPIC_API_KEY=
PORT=8787
```

When deployed via v0, the `AI_INTEGRATIONS_*` variables are injected automatically.

Credentials are resolved in the order **explicit override → platform-injected → gateway fallback**, and each key always travels with its own base URL:

1. `AI_INTEGRATIONS_OPENAI_*` / `AI_INTEGRATIONS_ANTHROPIC_*` (v0)
2. `OPENAI_API_KEY`+`OPENAI_BASE_URL` / `ANTHROPIC_API_KEY`+`ANTHROPIC_BASE_URL` (standard SDK vars; **Netlify's AI Gateway injects these automatically**)
3. `AI_GATEWAY_API_KEY` / Vercel OIDC / `NETLIFY_AI_GATEWAY_KEY`+`NETLIFY_AI_GATEWAY_BASE_URL` (unified gateway)

## Deployment

This project deploys to **both** Vercel and Netlify from the same `api/_lib` core:

- **Vercel** — `vercel.json` rewrites all gateway paths to the Express catch-all in `api/proxy.ts`.
- **Netlify** — `netlify.toml` builds the docs site to `apps/web/dist` (published as the site root) and `netlify/functions/gateway.mts` serves `/v1/*`, `/healthz`, and `/api/healthz`, bound via its own `config.path`. The function runs the same handlers as Express through a small Web `Request`/`Response` adapter (`api/_lib/web-adapter.ts`) that preserves true SSE streaming. On an AI-Gateway-enabled Netlify site, inference works with **zero configuration**.

## Development

```bash
pnpm install
pnpm dev          # runs both api (8787) and web (3000)
# or
pnpm dev:api
pnpm dev:web
```

The web app dev server proxies `/api/*` and `/v1/*` to `http://localhost:8787`, so the docs page at `http://localhost:3000` calls the proxy on the same origin.

## Build

```bash
pnpm build
pnpm start        # starts the API from apps/api/dist
```

## Quick test

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer 123" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4-6", "messages":[{"role":"user","content":"hi"}]}'
```
