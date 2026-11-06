/**
 * Make image-edit requests fit the upstream body limit (self-hosted app only).
 *
 * The Netlify AI Gateway rejects request bodies over 25 MiB ("Request body
 * exceeds the 26214400 byte limit"), and on Free-tier accounts already at
 * ~16 MiB ("Request size exceeds the allowed limit for your account tier").
 * gpt-image models work on downscaled inputs anyway, so an oversized body is
 * fixed by re-encoding its big images: each is fitted inside a max side and
 * stored as WebP (keeps alpha); a mask follows its image's new size and stays
 * PNG. Bodies at or under IMAGE_SHRINK_ABOVE bytes are left untouched.
 *
 * Only the Express app (VPS) imports this: sharp is a native module, and the
 * Netlify sites only ever receive bodies the VPS already prepared.
 */
import type { Request } from "express"
import sharp from "sharp"
import { normalizeImageEditJson } from "./routes/passthrough.js"
import { logger } from "./logger.js"

const MiB = 1024 * 1024
const envBytes = (name: string, dflt: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : dflt
}
// Touch a request only above this size, and make it end up at or under the limit.
const SHRINK_ABOVE = envBytes("IMAGE_SHRINK_ABOVE", 12 * MiB)
const BODY_LIMIT = envBytes("IMAGE_BODY_LIMIT", 15 * MiB)
// Images this small (and within the side limit) are kept byte for byte.
const KEEP_UNDER = 1 * MiB
// Successive tries, from gentle to strong; each starts again from the originals.
const PASSES = [
  { side: 2048, quality: 90 },
  { side: 1536, quality: 82 },
  { side: 1024, quality: 75 },
]
// ~11k x 11k; bigger inputs are refused instead of risking the box's memory.
const MAX_PIXELS = envBytes("IMAGE_MAX_PIXELS", 120_000_000)
const MAX_CONCURRENT = 2

sharp.cache(false)

let active = 0
const waiting: Array<() => void> = []
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

interface Encoded {
  data: Buffer
  mime: string
  width: number
  height: number
  changed: boolean
}

/** Fit an image inside `side` px as WebP; small ones that already fit stay as they are. */
async function encodeImage(data: Buffer, mime: string, side: number, quality: number): Promise<Encoded> {
  const meta = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata()
  const width = meta.autoOrient?.width ?? meta.width ?? 0
  const height = meta.autoOrient?.height ?? meta.height ?? 0
  if (data.length <= KEEP_UNDER && Math.max(width, height) <= side) return { data, mime, width, height, changed: false }
  const { data: out, info } = await sharp(data, { limitInputPixels: MAX_PIXELS, sequentialRead: true })
    .rotate()
    .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
    .webp({ quality, effort: 4 })
    .toBuffer({ resolveWithObject: true })
  return { data: out, mime: "image/webp", width: info.width, height: info.height, changed: true }
}

/** A mask must match its image's dimensions exactly. */
async function encodeMask(data: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(data, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width, height, fit: "fill" }).png().toBuffer()
}

const isGptImage = (model: unknown) => typeof model === "string" && /^(openai\/)?gpt-image/i.test(model)
const sizeText = (n: number) => `${(n / MiB).toFixed(1)} MB`
type Reject = { status: number; message: string }
type Fit<T> = { body: T } | { error: Reject } | null
const tooLarge = (before: number, after?: number): Reject => ({
  status: 413,
  message:
    `Request body is ${sizeText(before)}${after ? ` (${sizeText(after)} after compressing its images)` : ""}; ` +
    `the upstream accepts at most ${sizeText(BODY_LIMIT)}. Send fewer or smaller images.`,
})

// ---------- multipart ----------

interface Part {
  head: string
  data: Buffer
}

function parseMultipart(body: Buffer, boundary: string): Part[] | null {
  const first = Buffer.from(`--${boundary}`)
  const delim = Buffer.from(`\r\n--${boundary}`)
  let pos = body.indexOf(first)
  if (pos < 0) return null
  pos += first.length
  const parts: Part[] = []
  for (;;) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return parts // closing --boundary--
    pos += 2 // CRLF after the delimiter
    const next = body.indexOf(delim, pos)
    if (next < 0) return null
    const chunk = body.subarray(pos, next)
    const hEnd = chunk.indexOf("\r\n\r\n")
    if (hEnd < 0) return null
    parts.push({ head: chunk.subarray(0, hEnd).toString("utf8"), data: chunk.subarray(hEnd + 4) })
    pos = next + delim.length
  }
}

function buildMultipart(parts: Part[], boundary: string): Buffer {
  const out: Buffer[] = []
  for (const p of parts) out.push(Buffer.from(`--${boundary}\r\n${p.head}\r\n\r\n`), p.data, Buffer.from("\r\n"))
  out.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(out)
}

const fieldName = (head: string) => /\bname="([^"]*)"/i.exec(head)?.[1] ?? ""
const partMime = (head: string) => /^content-type:\s*([^\r\n;]+)/im.exec(head)?.[1]?.trim().toLowerCase() ?? ""

function withMime(head: string, mime: string): string {
  const ext = mime === "image/png" ? "png" : "webp"
  return head
    .replace(/(\bfilename="[^"]*?)(\.[A-Za-z0-9]+)?"/i, `$1.${ext}"`)
    .replace(/^content-type:[^\r\n]*/im, `Content-Type: ${mime}`)
}

async function shrinkMultipart(body: Buffer, boundary: string): Promise<Fit<Buffer>> {
  const parts = parseMultipart(body, boundary)
  if (!parts) return null
  const model = parts.find((p) => fieldName(p.head) === "model")?.data.toString("utf8").trim()
  if (!isGptImage(model)) return null
  const isImage = (p: Part) => /^image(\[\d*\])?$/.test(fieldName(p.head)) && (partMime(p.head).startsWith("image/") || /filename=/i.test(p.head))
  const isMask = (p: Part) => fieldName(p.head) === "mask"
  let last = body.length
  for (const pass of PASSES) {
    const out: Part[] = []
    let firstImage: Encoded | null = null
    for (const p of parts) {
      if (!isImage(p)) {
        out.push(p)
        continue
      }
      const e = await encodeImage(p.data, partMime(p.head) || "image/png", pass.side, pass.quality)
      firstImage ??= e
      out.push(e.changed ? { head: withMime(p.head, e.mime), data: e.data } : p)
    }
    const mask = out.findIndex(isMask)
    if (mask >= 0 && firstImage?.changed) {
      out[mask] = { head: withMime(out[mask].head, "image/png"), data: await encodeMask(out[mask].data, firstImage.width, firstImage.height) }
    }
    const next = buildMultipart(out, boundary)
    last = next.length
    if (next.length <= BODY_LIMIT) return { body: next }
  }
  return { error: tooLarge(body.length, last) }
}

// ---------- JSON (data URLs) ----------

interface ImageRef {
  image_url?: unknown
}
const DATA_URL = /^data:([^;,]*)(;base64)?,(.*)$/s

type EditJson = { model?: unknown; images?: ImageRef[]; mask?: ImageRef }
async function shrinkJson(body: EditJson, size: number): Promise<Fit<EditJson>> {
  if (!isGptImage(body.model) || !Array.isArray(body.images)) return null
  const originals = body.images.map((r) => (typeof r?.image_url === "string" ? DATA_URL.exec(r.image_url) : null))
  const maskUrl = typeof body.mask?.image_url === "string" ? DATA_URL.exec(body.mask.image_url) : null
  if (!originals.some((m) => m?.[2])) return null // nothing inline to shrink (URLs / file ids)
  let last = size
  for (const pass of PASSES) {
    let firstImage: Encoded | null = null
    const images: ImageRef[] = []
    for (let i = 0; i < body.images.length; i++) {
      const m = originals[i]
      if (!m?.[2]) {
        images.push(body.images[i])
        continue
      }
      const e = await encodeImage(Buffer.from(m[3], "base64"), m[1] || "image/png", pass.side, pass.quality)
      if (i === 0) firstImage = e
      images.push(e.changed ? { ...body.images[i], image_url: `data:${e.mime};base64,${e.data.toString("base64")}` } : body.images[i])
    }
    let mask = body.mask
    if (maskUrl?.[2] && firstImage?.changed) {
      const png = await encodeMask(Buffer.from(maskUrl[3], "base64"), firstImage.width, firstImage.height)
      mask = { ...body.mask, image_url: `data:image/png;base64,${png.toString("base64")}` }
    }
    const next = { ...body, images, ...(mask ? { mask } : {}) }
    last = Buffer.byteLength(JSON.stringify(next))
    if (last <= BODY_LIMIT) return { body: next }
  }
  return { error: tooLarge(size, last) }
}

/**
 * POST /v1/images/edits: normalize JSON edits, then shrink an oversized body in
 * place. Returns an error to send instead (status + message), or null to go on.
 */
export async function fitImageEdit(req: Request): Promise<Reject | null> {
  const t0 = Date.now()
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length <= SHRINK_ABOVE) return null
    const ct = String(req.headers["content-type"] ?? "")
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ct)
    if (!boundary) return null
    const before = req.body.length
    try {
      const r = await withSlot(() => shrinkMultipart(req.body as Buffer, boundary[1] ?? boundary[2]))
      if (!r) return before > BODY_LIMIT ? tooLarge(before) : null
      if ("error" in r) return r.error
      req.body = r.body
      logger.info({ before, after: r.body.length, ms: Date.now() - t0 }, "image edit shrunk (multipart)")
      return null
    } catch (err) {
      logger.warn({ err, before }, "image shrink failed")
      return before > BODY_LIMIT ? { status: 400, message: `Could not read the input image: ${(err as Error).message}` } : null
    }
  }
  if (!req.body || typeof req.body !== "object") return null
  normalizeImageEditJson(req.body as Record<string, unknown>)
  const before = Buffer.byteLength(JSON.stringify(req.body))
  if (before <= SHRINK_ABOVE) return null
  try {
    const r = await withSlot(() => shrinkJson(req.body as EditJson, before))
    if (!r) return before > BODY_LIMIT ? tooLarge(before) : null
    if ("error" in r) return r.error
    req.body = r.body
    logger.info({ before, after: Buffer.byteLength(JSON.stringify(r.body)), ms: Date.now() - t0 }, "image edit shrunk (json)")
    return null
  } catch (err) {
    logger.warn({ err, before }, "image shrink failed")
    return before > BODY_LIMIT ? { status: 400, message: `Could not read the input image: ${(err as Error).message}` } : null
  }
}
