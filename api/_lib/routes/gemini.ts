import type { Request, Response } from "express"
import { handleChatCompletions } from "./chat-completions.js"
import { listModels } from "../models.js"
import { readOidcToken, UpstreamUnreachableError } from "../upstream.js"
import { parseSseStream, safeCancel } from "../sse.js"
import { WebResShim } from "../web-adapter.js"
import { redactErrorMessage } from "../redact.js"
import { logger } from "../logger.js"
import {
  geminiError,
  toGeminiError,
  parseModelAction,
  geminiToOpenAIRequest,
  openAIToGeminiResponse,
  GeminiStreamConverter,
  geminiModelEntry,
  estimateTokens,
} from "../gemini.js"

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `/v1beta/models/{rest}` or `/v1/models/{rest}` → `{rest}`. */
const restOf = (req: Request) => req.path.replace(/^\/v1(beta)?\/models\/?/, "")

/**
 * Run the normal /v1/chat/completions pipeline in-process (failover, Claude
 * conversion, stream watchdogs all apply) and hand back its Web Response.
 * Aborting `res` cancels the inner stream, which cancels the upstream.
 */
async function runChat(req: Request, body: Record<string, unknown>): Promise<globalThis.Response> {
  const shim = new WebResShim()
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v
  const inner = {
    method: "POST",
    path: "/v1/chat/completions",
    originalUrl: "/v1/chat/completions",
    headers,
    header: (n: string) => headers[n.toLowerCase()],
    body,
  }
  handleChatCompletions(inner as never, shim as never).catch((err) => {
    logger.error({ err }, "gemini: chat pipeline error")
    if (!shim.headersSent) {
      const code = err instanceof UpstreamUnreachableError ? 502 : 500
      shim.status(code).json({ error: { message: redactErrorMessage(err) } })
    } else if (!shim.writableEnded) shim.end()
  })
  return shim.getResponse()
}

/** GET /v1beta/models and /v1beta/models/{model}. */
export async function handleGeminiModels(req: Request, res: Response) {
  const { data } = await listModels({ oidcToken: readOidcToken(req) })
  const entries = (data as any[]).map((m) => geminiModelEntry({ id: m.id, context_window: m.context_window ?? 0 }))
  const rest = restOf(req)
  if (!rest) return res.json({ models: entries })
  const { model } = parseModelAction(rest)
  const hit = entries.find((e) => e.baseModelId === model)
  return hit ? res.json(hit) : res.status(404).json(geminiError(404, `models/${model} is not found.`))
}

/** POST /v1beta/models/{model}:{generateContent|streamGenerateContent|countTokens}. */
export async function handleGemini(req: Request, res: Response) {
  const { model, action } = parseModelAction(restOf(req))
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>
  if (!model) return res.status(400).json(geminiError(400, "Missing model in the request path."))

  if (action === "countTokens") return res.json({ totalTokens: estimateTokens(body) })
  if (action !== "generateContent" && action !== "streamGenerateContent") {
    return res.status(404).json(geminiError(404, `Method '${action ?? ""}' is not supported by this endpoint.`))
  }

  const stream = action === "streamGenerateContent"
  const oai = geminiToOpenAIRequest(body, model, stream)
  if (!(oai.messages as unknown[]).length) return res.status(400).json(geminiError(400, "contents is not specified"))

  const r = await runChat(req, oai)
  const ct = r.headers.get("content-type") ?? ""
  const rb = r.body

  if (r.status >= 400 || !rb || (stream && !ct.includes("text/event-stream"))) {
    const text = rb ? await r.text() : ""
    // A 2xx JSON answer to a stream request should not happen; treat as an error.
    return res.status(r.status >= 400 ? r.status : 502).json(toGeminiError(r.status >= 400 ? r.status : 502, text))
  }

  if (!stream) {
    const text = await r.text()
    try {
      return res.json(openAIToGeminiResponse(JSON.parse(text), model))
    } catch {
      return res.status(502).json(geminiError(502, "upstream returned an unreadable response"))
    }
  }

  // Streaming: `?alt=sse` (what the SDKs use) → SSE; otherwise a streamed JSON array.
  const sse = req.query.alt === "sse"
  const src = rb.getReader()
  res.on("close", () => safeCancel(src))
  const body2 = new ReadableStream<Uint8Array>({
    pull: async (c) => {
      const { value, done } = await src.read()
      if (done) c.close()
      else c.enqueue(value)
    },
    cancel: () => safeCancel(src),
  })

  res.status(200)
  res.setHeader("content-type", sse ? "text/event-stream" : "application/json; charset=utf-8")
  res.setHeader("cache-control", "no-cache")
  res.flushHeaders?.()
  let sent = 0
  const emit = (obj: unknown) => {
    const json = JSON.stringify(obj)
    if (sse) res.write(`data: ${json}\r\n\r\n`)
    else res.write(`${sent === 0 ? "[" : ",\r\n"}${json}`)
    sent++
  }

  const conv = new GeminiStreamConverter(model)
  try {
    for await (const ev of parseSseStream(body2)) {
      if (!ev.data || ev.data === "[DONE]") continue
      let j: any
      try {
        j = JSON.parse(ev.data)
      } catch {
        continue
      }
      if (j?.error) {
        emit(geminiError(502, String(j.error.message ?? "upstream error")))
        break
      }
      for (const c of conv.push(j)) emit(c)
    }
    for (const c of conv.end()) emit(c)
  } catch (err) {
    logger.warn({ err }, "gemini stream conversion aborted")
    emit(geminiError(504, redactErrorMessage(err)))
  } finally {
    if (!sse) res.write(sent === 0 ? "[]" : "]")
    if (!res.writableEnded) res.end()
  }
}
