/**
 * Image jobs for Netlify: run slow image calls in a background function.
 *
 * A site function is cut off at ~30s on these accounts, which is too short for
 * gpt-image edits/high-quality generations. A background function gets 15 min
 * but can't answer the caller (it returns 202 immediately), so a job is split:
 *
 *   POST /v1/jobs/images/<op>   stash the request in Netlify Blobs, kick
 *                               `image-job-background`, answer 202 {id}
 *   (background)                replay the stashed request through the normal
 *                               OpenAI passthrough, store status + body
 *   GET  /v1/jobs/<id>          202 {status:"pending"} until done, then the
 *                               upstream response verbatim (status + content-type)
 *
 * Request bodies go through Blobs because a background function only accepts a
 * 256 KB payload. Finished jobs are swept after JOB_TTL_MS.
 */
import { getStore } from "@netlify/blobs"
import type { Request as ExpressRequest, Response as ExpressResponse } from "express"
import { toExpressReq, WebResShim } from "./web-adapter.js"
import { handleOpenAIPassthrough } from "./routes/passthrough.js"
import { logger } from "./logger.js"

const JOB_TTL_MS = 60 * 60_000
const OPS = /^\/images\/(generations|edits|variations)$/
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

  void sweep().catch((err) => logger.warn({ err }, "image-jobs sweep failed"))

  const id = `${Date.now()}-${crypto.randomUUID()}`
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body ?? {}))
  const ct = request.headers.get("content-type") ?? "application/json"
  await store().set(`${id}/req`, toArrayBuffer(bytes), { metadata: { path: `/v1${sub}`, ct } })

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

/** GET /v1/jobs/<id> */
export async function pollImageJob(path: string): Promise<Response> {
  const id = path.slice("/v1/jobs/".length)
  if (!ID_RE.test(id)) return json(404, { error: { message: "unknown job", type: "not_found" } })
  const done = await store().getWithMetadata(`${id}/res`, { type: "stream" })
  if (done) {
    const meta = done.metadata as { status?: number; ct?: string }
    return new Response(done.data, { status: meta.status ?? 200, headers: { "content-type": meta.ct ?? "application/json" } })
  }
  if (await store().getMetadata(`${id}/req`)) return json(202, { id, status: "pending" })
  return json(404, { error: { message: "unknown or expired job", type: "not_found" } })
}

/** Background worker body: replay the stashed request and store the result. */
export async function runImageJob(id: string): Promise<void> {
  if (!ID_RE.test(id)) return
  const job = await store().getWithMetadata(`${id}/req`, { type: "arrayBuffer" })
  if (!job) return
  const { path, ct } = job.metadata as { path: string; ct: string }
  const t0 = Date.now()
  let status = 500
  let outCt = "application/json"
  let out: ArrayBuffer
  try {
    const req = await toExpressReq(new Request(`https://job.invalid${path}`, { method: "POST", headers: { "content-type": ct }, body: job.data }), path)
    const res = new WebResShim()
    await handleOpenAIPassthrough(req as unknown as ExpressRequest, res as unknown as ExpressResponse, path.slice("/v1".length))
    const r = await res.getResponse()
    status = r.status
    outCt = r.headers.get("content-type") ?? outCt
    out = await r.arrayBuffer()
  } catch (err) {
    logger.error({ err, path }, "image job failed")
    const message = err instanceof Error ? err.message : "image job failed"
    out = toArrayBuffer(Buffer.from(JSON.stringify({ error: { message, type: "upstream_error", code: 502 } })))
    status = 502
  }
  await store().set(`${id}/res`, out, { metadata: { status, ct: outCt } })
  logger.info({ path, status, ms: Date.now() - t0, bytes: out.byteLength }, "image job done")
}

/** Drop jobs older than JOB_TTL_MS (the id starts with its creation time). */
async function sweep() {
  const { blobs } = await store().list()
  const cutoff = Date.now() - JOB_TTL_MS
  await Promise.all(
    blobs
      .filter((b) => Number(b.key.slice(0, 13)) < cutoff)
      .map((b) => store().delete(b.key)),
  )
}
