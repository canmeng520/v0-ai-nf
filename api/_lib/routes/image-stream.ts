/**
 * `stream: true` on /images/generations and /images/edits (self-hosted app only).
 *
 * The Netlify AI Gateway refuses streamed image calls ("action stream doesn't
 * support value true"), so partial previews can't be had. Clients written for
 * the streaming API still get their image: the call runs non-streaming, the
 * client stream stays open with heartbeats, and the result arrives as the
 * OpenAI terminal event (`image_generation.completed` / `image_edit.completed`,
 * one per image). A failure that comes back quickly keeps its real HTTP status;
 * a later one ends the stream with an `error` event.
 */
import type { Request, Response } from "express"
import { handleOpenAIPassthrough } from "./passthrough.js"
import { parseMultipart, buildMultipart, fieldName } from "../image-shrink.js"
import { WebResShim } from "../web-adapter.js"
import { UpstreamUnreachableError } from "../upstream.js"
import { redactErrorMessage } from "../redact.js"
import { logger } from "../logger.js"

// Errors within this window (validation, auth) are sent as a plain HTTP error.
const EARLY_MS = 4000
const HEARTBEAT_MS = 10_000

/** Whether the request asks for a streamed image response. */
export function wantsImageStream(req: Request): boolean {
  if (Buffer.isBuffer(req.body)) return /name="stream"\r\n\r\ntrue\r\n/.test(req.body.toString("latin1"))
  return (req.body as { stream?: unknown } | undefined)?.stream === true
}

/** Drop `stream` / `partial_images` so the upstream gets a plain call. */
function stripStreamFields(req: Request): void {
  if (!Buffer.isBuffer(req.body)) {
    const b = req.body as Record<string, unknown>
    delete b.stream
    delete b.partial_images
    return
  }
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(req.headers["content-type"] ?? ""))
  if (!boundary) return
  const b = boundary[1] ?? boundary[2]
  const parts = parseMultipart(req.body, b)
  if (parts) req.body = buildMultipart(parts.filter((p) => !["stream", "partial_images"].includes(fieldName(p.head))), b)
}

const sse = (res: Response, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms))

export async function handleImageStream(req: Request, res: Response, subpath: string) {
  const kind = subpath === "/images/edits" ? "image_edit" : "image_generation"
  stripStreamFields(req)

  // Run the normal passthrough in-process and collect its whole answer.
  const shim = new WebResShim()
  const call = handleOpenAIPassthrough(req, shim as never, subpath).catch((err) => {
    logger.error({ err, subpath }, "image stream: passthrough failed")
    if (!shim.headersSent) {
      shim.status(err instanceof UpstreamUnreachableError ? 502 : 500).json({ error: { message: redactErrorMessage(err), type: "upstream_error" } })
    } else if (!shim.writableEnded) shim.end()
  })
  const result = shim.getResponse().then(async (r) => ({ status: r.status, text: await r.text() }))

  const early = await Promise.race([result, sleep(EARLY_MS)])
  if (early && early.status >= 400) {
    res.status(early.status).setHeader("content-type", "application/json")
    return res.end(early.text)
  }

  res.status(200)
  res.setHeader("content-type", "text/event-stream")
  res.setHeader("cache-control", "no-cache")
  res.setHeader("x-accel-buffering", "no")
  res.flushHeaders?.()
  res.write(": keepalive\n\n") // a first byte now: some clients time out an idle stream
  const beat = setInterval(() => {
    try {
      res.write(": keepalive\n\n")
    } catch {
      /* client gone */
    }
  }, HEARTBEAT_MS)
  try {
    const r = early ?? (await result)
    await call
    let j: Record<string, any> | null = null
    try {
      j = JSON.parse(r.text)
    } catch {
      /* not JSON */
    }
    if (r.status >= 400 || !Array.isArray(j?.data)) {
      sse(res, "error", { type: "error", error: j?.error ?? { message: `upstream returned ${r.status}`, type: "upstream_error" } })
    } else {
      for (const img of j!.data) {
        sse(res, `${kind}.completed`, {
          type: `${kind}.completed`,
          b64_json: img.b64_json,
          ...(img.revised_prompt ? { revised_prompt: img.revised_prompt } : {}),
          created_at: j!.created ?? Math.floor(Date.now() / 1000),
          size: j!.size,
          quality: j!.quality,
          background: j!.background,
          output_format: j!.output_format,
          ...(j!.usage ? { usage: j!.usage } : {}),
        })
      }
    }
  } finally {
    clearInterval(beat)
    if (!res.writableEnded) res.end()
  }
}
