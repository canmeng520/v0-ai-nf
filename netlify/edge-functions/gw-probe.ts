// STAGE 0 — throwaway go/no-go probe for the Edge-Function gateway path.
// Answers two make-or-break questions before we port anything:
//   1. Are the AI-Gateway creds visible to an Edge Function (Deno)?
//   2. Can an Edge Function stream a gpt-6-astra response PAST the 60s wall that
//      kills the serverless function?
// Bound to /edge/probe via netlify.toml. Delete after the decision.
//
// GET /edge/probe            -> JSON: which env var NAMES are present (never values)
// GET /edge/probe?run=1      -> SSE: proxies one long gpt-6-astra stream, then a
//                               final `event: probe` with timing + completion flags.

// Netlify injects env into Edge via Netlify.env; fall back to Deno.env.
declare const Netlify: { env: { get(k: string): string | undefined } } | undefined
function envGet(k: string): string | undefined {
  try {
    // @ts-ignore - Netlify global only exists at runtime
    const v = typeof Netlify !== "undefined" ? Netlify.env.get(k) : undefined
    if (v) return v
  } catch {
    /* ignore */
  }
  try {
    // @ts-ignore - Deno global only exists at runtime
    return Deno.env.get(k)
  } catch {
    return undefined
  }
}

const CRED_KEYS = [
  "NETLIFY_AI_GATEWAY_KEY",
  "NETLIFY_AI_GATEWAY_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
]

function presentEnv(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const k of CRED_KEYS) out[k] = Boolean(envGet(k))
  return out
}

/** Resolve an OpenAI-compatible base URL + key from whatever the gateway injects. */
function resolveOpenAI(): { baseUrl: string; key: string; via: string } | null {
  const nlKey = envGet("NETLIFY_AI_GATEWAY_KEY")
  const nlUrl = envGet("NETLIFY_AI_GATEWAY_URL")
  if (nlKey && nlUrl) return { baseUrl: nlUrl.replace(/\/+$/, "") + "/v1", key: nlKey, via: "netlify-gateway" }
  const oaKey = envGet("OPENAI_API_KEY")
  const oaUrl = envGet("OPENAI_BASE_URL")
  if (oaKey && oaUrl) return { baseUrl: oaUrl.replace(/\/+$/, ""), key: oaKey, via: "openai-sdk-vars" }
  return null
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const cors = { "access-control-allow-origin": "*" }

  // Self-test: stream a heartbeat every 2s for 90s with NO upstream call. If this
  // survives past 60s, the edge runtime itself does NOT cap us → any 60s cut on
  // ?run=1 is the upstream Netlify AI Gateway. If this also dies at ~60s, the cap
  // is the edge runtime.
  if (url.searchParams.get("selftest") === "1") {
    const enc = new TextEncoder()
    const start = Date.now()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(`: start\n\n`))
        for (let i = 0; i < 45; i++) {
          await new Promise((r) => setTimeout(r, 2000))
          const t = Date.now() - start
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ tick: i, ms: t })}\n\n`))
          if (t > 88000) break
        }
        controller.enqueue(enc.encode(`event: selftest\ndata: ${JSON.stringify({ done: true, totalMs: Date.now() - start })}\n\n`))
        controller.close()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...cors },
    })
  }

  if (url.searchParams.get("run") !== "1") {
    return new Response(
      JSON.stringify({ ok: true, runtime: "edge", env: presentEnv(), resolved: Boolean(resolveOpenAI()) }, null, 2),
      { headers: { "content-type": "application/json", ...cors } },
    )
  }

  const cfg = resolveOpenAI()
  if (!cfg) {
    return new Response(JSON.stringify({ error: "no gateway creds visible in edge", env: presentEnv() }), {
      status: 503,
      headers: { "content-type": "application/json", ...cors },
    })
  }

  const model = url.searchParams.get("model") ?? "gpt-6-astra"
  // gpt-5+/o-series reject `max_tokens`; use max_completion_tokens for them.
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  const gptGen = /^gpt-(\d+)/i.exec(bare)
  const reasoning = (gptGen && Number(gptGen[1]) >= 5) || /^o[0-9]/i.test(bare)
  const tokenField = reasoning ? "max_completion_tokens" : "max_tokens"
  const started = Date.now()
  const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model,
      stream: true,
      [tokenField]: 8000,
      messages: [
        { role: "user", content: "画一只骑自行车的鹈鹕，做成带动画的 SVG（车轮转动、脚踏联动）。给出完整可运行的 SVG 代码，并逐段解释。" },
      ],
    }),
  })

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    return new Response(JSON.stringify({ error: "upstream not ok", status: upstream.status, body: text.slice(0, 300) }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    })
  }

  // Pipe upstream SSE straight to the client, tracking timing + completion, and
  // append a final `event: probe` summary so we can read the verdict from curl.
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const reader = upstream.body.getReader()
  let firstByteMs: number | null = null
  let sawDone = false
  let sawStop = false

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          const summary = {
            type: "probe",
            via: cfg.via,
            model,
            firstByteMs,
            totalMs: Date.now() - started,
            pastWall: Date.now() - started > 60000,
            sawDone,
            sawStop,
          }
          controller.enqueue(enc.encode(`event: probe\ndata: ${JSON.stringify(summary)}\n\n`))
          controller.close()
          return
        }
        if (value) {
          if (firstByteMs === null) firstByteMs = Date.now() - started
          const s = dec.decode(value, { stream: true })
          if (s.includes("[DONE]")) sawDone = true
          if (s.includes('"finish_reason":"stop"') || s.includes("response.completed")) sawStop = true
          controller.enqueue(value)
        }
      } catch (e) {
        controller.enqueue(enc.encode(`event: probe\ndata: ${JSON.stringify({ type: "probe", error: String(e), totalMs: Date.now() - started })}\n\n`))
        controller.close()
      }
    },
    cancel() {
      reader.cancel().catch(() => {})
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...cors,
    },
  })
}

export const config = { path: "/edge/probe" }
