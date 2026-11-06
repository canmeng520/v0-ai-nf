/**
 * Background jobs for Netlify: run slow calls in a background function.
 *
 * A site function is cut off at ~30s on these accounts, which is too short for
 * gpt-image edits/high-quality generations and for long or heavily-reasoning
 * text completions. A background function gets 15 min but can't answer the
 * caller (it returns 202 immediately), so a job is split:
 *
 *   POST /v1/jobs/<route>       stash the request in Netlify Blobs, kick
 *                               `image-job-background`, answer 202 {id}
 *                               (<route>: images/<op>, chat/completions,
 *                               messages, responses; text routes may stream)
 *   (background)                replay the stashed request through the normal
 *                               route handler, store status + body
 *   GET  /v1/jobs/<id>          202 {status:"pending"} until done, then the
 *                               response verbatim (status + content-type);
 *                               `?wait=<s>` holds the call up to 20 s for it
 *   GET  /v1/jobs/<id>/stream   streaming text jobs: the output as it is
 *                               produced (see readJobStream)
 *   POST /v1/jobs/start {id}    kick a job whose request the caller uploaded to
 *                               Blobs itself (bodies over the ~6 MB function limit)
 *
 * Request bodies go through Blobs because a background function only accepts a
 * 256 KB payload. Finished jobs are swept after JOB_TTL_MS.
 */
import { getStore } from "@netlify/blobs"
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"
import { toExpressReq, WebResShim } from "./web-adapter.js"
import { handleOpenAIPassthrough } from "./routes/passthrough.js"
import { handleChatCompletions } from "./routes/chat-completions.js"
import { handleMessages } from "./routes/messages.js"
import { logger } from "./logger.js"

const JOB_TTL_MS = 60 * 60_000
const OPS = /^\/(images\/(generations|edits|variations)|chat\/completions|messages|responses)$/

/** Run one stashed request through the same handler the sync route uses. */
function handlerFor(sub: string): (req: ExpressRequest, res: ExpressResponse) => Promise<unknown> {
  if (sub === "/chat/completions") return handleChatCompletions
  if (sub === "/messages") return handleMessages
  return (req, res) => handleOpenAIPassthrough(req, res, sub) // images/*, responses
}

const TEXT_OPS = /^\/(chat\/completions|messages|responses)$/

function wantsStream(body: unknown): boolean {
  return !Buffer.isBuffer(body) && typeof body === "object" && body !== null && (body as { stream?: unknown }).stream === true
}
const ID_RE = /^(\d{13})-[0-9a-f-]{36}$/
export const WORKER_PATH = "/.netlify/functions/image-job-background"

const store = () => getStore({ name: "image-jobs", consistency: "strong" })

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const toArrayBuffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** POST /v1/jobs/images/<op> — `body` is the already-parsed request body (JSON object or raw multipart Buffer). */
export async function submitImageJob(request: Request, body: unknown, path: string): Promise<Response> {
  const sub = path.slice("/v1/jobs".length)
  if (!OPS.test(sub)) return json(404, { error: { message: `Not found: POST ${path}`, type: "not_found" } })
  // Image streams (partial images) can't be relayed; text streams go out through readJobStream.
  if (wantsStream(body) && !TEXT_OPS.test(sub)) return json(400, { error: { message: "streaming requests can't run as a job", type: "invalid_request_error" } })

  void sweep().catch((err) => logger.warn({ err }, "image-jobs sweep failed"))

  const id = `${Date.now()}-${crypto.randomUUID()}`
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}))
  const ct = request.headers.get("content-type") ?? "application/json"
  await store().set(`${id}/req`, toArrayBuffer(bytes), { metadata: { path: `/v1${sub}`, ct } })
  return kickWorker(request, id)
}

/**
 * POST /v1/jobs/start {id} — for requests too large for a function payload
 * (~6 MB): the caller has already written `${id}/req` (same metadata as above)
 * straight into the "image-jobs" store via the Blobs API with the account PAT.
 */
export async function startImageJob(request: Request, body: unknown): Promise<Response> {
  const id = (body as { id?: unknown } | undefined)?.id
  if (typeof id !== "string" || !ID_RE.test(id)) return json(400, { error: { message: "invalid job id", type: "invalid_request_error" } })
  const meta = (await store().getMetadata(`${id}/req`))?.metadata as { path?: string } | undefined
  if (!meta?.path || !OPS.test(meta.path.slice("/v1".length))) {
    return json(404, { error: { message: "job request not found", type: "not_found" } })
  }
  void sweep().catch((err) => logger.warn({ err }, "image-jobs sweep failed"))
  return kickWorker(request, id)
}

async function kickWorker(request: Request, id: string): Promise<Response> {
  // The worker checks the same API key the caller just passed.
  const auth: Record<string, string> = { "content-type": "application/json" }
  for (const h of ["authorization", "x-api-key"]) {
    const v = request.headers.get(h)
    if (v) auth[h] = v
  }
  const kick = await fetch(new URL(WORKER_PATH, request.url), { method: "POST", headers: auth, body: JSON.stringify({ id }) })
  if (kick.status !== 202) {
    await store().delete(`${id}/req`)
    return json(502, { error: { message: `background worker did not start (${kick.status})`, type: "job_start_failed" } })
  }
  return json(202, { id, status: "pending" })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** GET /v1/jobs/<id>[?wait=<s>] — waiting here costs one call instead of one per second of polling. */
export async function pollImageJob(path: string, url?: URL): Promise<Response> {
  const id = path.slice("/v1/jobs/".length)
  if (!ID_RE.test(id)) return json(404, { error: { message: "unknown job", type: "not_found" } })
  const until = Date.now() + Math.min(Math.max(Number(url?.searchParams.get("wait")) || 0, 0), 20) * 1000
  for (let first = true; ; first = false) {
    const done = await store().getWithMetadata(`${id}/res`, { type: "stream" })
    if (done) {
      const meta = done.metadata as { status?: number; ct?: string }
      return new Response(done.data, { status: meta.status ?? 200, headers: { "content-type": meta.ct ?? "application/json" } })
    }
    if (first && !(await store().getMetadata(`${id}/req`))) return json(404, { error: { message: "unknown or expired job", type: "not_found" } })
    if (Date.now() >= until) return json(202, { id, status: "pending" })
    await sleep(500)
  }
}

// ---------- streaming text jobs ----------
// The worker writes `${id}/head` {status, ct} once the handler commits its
// headers, then the body in numbered chunks (`${id}/s/000000`, …) flushed every
// JOB_STREAM_FLUSH_MS, then `${id}/done` {chunks}. readJobStream relays them.
const STREAM_FLUSH_MS = Number(process.env.JOB_STREAM_FLUSH_MS) || 400
// One reader call stays well under the ~30 s sync function limit; the caller
// reconnects with `?from=<next chunk>`.
const STREAM_READ_MS = Number(process.env.JOB_STREAM_READ_MS) || 22_000
const chunkKey = (id: string, n: number) => `${id}/s/${String(n).padStart(6, "0")}`

/**
 * GET /v1/jobs/<id>/stream?from=<n> — newline-delimited JSON frames:
 *   {"head":{status,ct}}            first, when from=0
 *   {"seq":n,"data":"<base64>"}     body chunks in order
 *   {"ping":true}                   every 5 s without data
 *   {"done":true}                   the job is finished and fully sent
 * The response just ends when the read window is over; call again from the next seq.
 */
export async function readJobStream(path: string, url: URL): Promise<Response> {
  const id = path.slice("/v1/jobs/".length, -"/stream".length)
  if (!ID_RE.test(id) || !(await store().getMetadata(`${id}/req`))) {
    return json(404, { error: { message: "unknown or expired job", type: "not_found" } })
  }
  const from = Math.max(0, Math.floor(Number(url.searchParams.get("from")) || 0))
  const st = store()
  const enc = new TextEncoder()
  const stopAt = Date.now() + STREAM_READ_MS
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (o: unknown) => c.enqueue(enc.encode(JSON.stringify(o) + "\n"))
      let seq = from
      let quiet = Date.now()
      try {
        if (from === 0) {
          let head: unknown = null
          while (!head && Date.now() < stopAt) {
            head = await st.get(`${id}/head`, { type: "json" })
            if (!head) await sleep(250)
          }
          if (!head) return c.close()
          send({ head })
        }
        while (Date.now() < stopAt) {
          const chunk = await st.get(chunkKey(id, seq), { type: "arrayBuffer" })
          if (chunk) {
            send({ seq, data: Buffer.from(chunk).toString("base64") })
            seq++
            quiet = Date.now()
            continue
          }
          const done = (await st.get(`${id}/done`, { type: "json" })) as { chunks: number; broken?: boolean } | null
          if (done && (seq >= done.chunks || done.broken)) {
            send({ done: true, ...(done.broken ? { broken: true } : {}) })
            await dropJob(id)
            break
          }
          if (Date.now() - quiet >= 5000) {
            send({ ping: true })
            quiet = Date.now()
          }
          await sleep(250)
        }
      } catch (err) {
        logger.warn({ err, id }, "job stream read failed")
      }
      try {
        c.close()
      } catch {
        /* the caller hung up after `done` */
      }
    },
  })
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } })
}

async function dropJob(id: string) {
  try {
    const { blobs } = await store().list({ prefix: `${id}/` })
    await Promise.all(blobs.map((b) => store().delete(b.key)))
  } catch (err) {
    logger.warn({ err, id }, "job cleanup failed")
  }
}

function isStreamJob(path: string, ct: string, data: ArrayBuffer): boolean {
  if (!TEXT_OPS.test(path.slice("/v1".length)) || !ct.includes("json")) return false
  try {
    return JSON.parse(Buffer.from(data).toString("utf8"))?.stream === true
  } catch {
    return false
  }
}

/** Worker body for a streaming text job: relay the handler's output into Blobs as it comes. */
async function runStreamJob(id: string, path: string, ct: string, data: ArrayBuffer): Promise<void> {
  const st = store()
  const t0 = Date.now()
  let seq = 0
  let bytes = 0
  let broken = false
  const pending: Buffer[] = []
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let writes: Promise<void> = Promise.resolve()
  // Chunk numbers are taken in output order and the writes are chained, so
  // chunk n is always stored before n+1 (and before `done`).
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!pendingBytes) return
    const buf = toArrayBuffer(Buffer.concat(pending))
    pending.length = 0
    pendingBytes = 0
    const key = chunkKey(id, seq++)
    writes = writes.then(async () => {
      if (broken) return
      try {
        await st.set(key, buf)
      } catch {
        try {
          await st.set(key, buf)
        } catch (err) {
          broken = true
          logger.error({ err, id, key }, "job stream chunk write failed")
        }
      }
    })
  }
  const push = (b: Uint8Array) => {
    pending.push(Buffer.from(b))
    pendingBytes += b.byteLength
    bytes += b.byteLength
    if (pendingBytes >= 64 * 1024) flush()
    else if (!timer) timer = setTimeout(flush, STREAM_FLUSH_MS)
  }

  let headWritten = false
  try {
    const req = await toExpressReq(new Request(`https://job.invalid${path}`, { method: "POST", headers: { "content-type": ct }, body: data }), path)
    const res = new WebResShim()
    // A streaming handler only returns once its stream is over, so read its
    // output while it runs.
    const running = handlerFor(path.slice("/v1".length))(req as unknown as ExpressRequest, res as unknown as ExpressResponse).catch((err) => {
      logger.error({ err, path }, "stream job handler failed")
      if (!res.headersSent) res.status(502).json({ error: { message: err instanceof Error ? err.message : "job failed", type: "upstream_error", code: 502 } })
      else if (!res.writableEnded) res.end()
    })
    const r = await res.getResponse()
    await st.setJSON(`${id}/head`, { status: r.status, ct: r.headers.get("content-type") ?? "application/json" })
    headWritten = true
    if (r.body) {
      const reader = r.body.getReader()
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value?.byteLength) push(value)
      }
    }
    await running
  } catch (err) {
    logger.error({ err, path }, "stream job failed")
    const message = err instanceof Error ? err.message : "job failed"
    if (!headWritten) await st.setJSON(`${id}/head`, { status: 502, ct: "application/json" }).catch(() => {})
    push(Buffer.from(JSON.stringify({ error: { message, type: "upstream_error", code: 502 } })))
  }
  flush()
  await writes
  await st.setJSON(`${id}/done`, { chunks: seq, ms: Date.now() - t0, ...(broken ? { broken: true } : {}) })
  logger.info({ path, chunks: seq, bytes, ms: Date.now() - t0, broken }, "stream job done")
}

/** Background worker body: replay the stashed request and store the result. */
export async function runImageJob(id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  const job = await store().getWithMetadata(`${id}/req`, { type: "arrayBuffer" })
  if (!job) return
  const { path, ct } = job.metadata as { path: string; ct: string }
  if (isStreamJob(path, ct, job.data)) return runStreamJob(id, path, ct, job.data)
  const t0 = Date.now()
  let status = 500
  let outCt = "application/json"
  let out: ArrayBuffer
  try {
    const req = await toExpressReq(new Request(`https://job.invalid${path}`, { method: "POST", headers: { "content-type": ct }, body: job.data }), path)
    const res = new WebResShim()
    await handlerFor(path.slice("/v1".length))(req as unknown as ExpressRequest, res as unknown as ExpressResponse)
    const r = await res.getResponse()
    status = r.status
    outCt = r.headers.get("content-type") ?? outCt
    out = await r.arrayBuffer()
  } catch (err) {
    logger.error({ err, path }, "job failed")
    const message = err instanceof Error ? err.message : "job failed"
    out = toArrayBuffer(Buffer.from(JSON.stringify({ error: { message, type: "upstream_error", code: 502 } })))
    status = 502
  }
  await store().set(`${id}/res`, out, { metadata: { status, ct: outCt } })
  logger.info({ path, status, ms: Date.now() - t0, bytes: out.byteLength }, "job done")
}

/** Drop jobs older than JOB_TTL_MS (the id starts with its creation time). */
let lastSweep = 0
async function sweep() {
  // Text jobs submit often and list() walks the whole store: at most every 10 min per instance.
  if (Date.now() - lastSweep < 10 * 60_000) return
  lastSweep = Date.now()
  const { blobs } = await store().list()
  const cutoff = Date.now() - JOB_TTL_MS
  await Promise.all(
    blobs
      .filter((b) => Number(b.key.slice(0, 13)) < cutoff)
      .map((b) => store().delete(b.key)),
  )
}
