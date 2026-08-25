/**
 * Minimal Express ⇄ Web (Fetch) adapter.
 *
 * Netlify Functions speak the Web `Request`/`Response` standard, while our route
 * handlers were written against the small slice of the Express `req`/`res` API
 * listed below. Rather than duplicate the routing/streaming logic, we implement
 * exactly that slice on top of a `ReadableStream`, so a single set of handlers
 * runs on both Express (local + Vercel) and Netlify — with real streaming, not a
 * buffered one-shot.
 *
 * `res` surface used by the handlers + sse.ts:
 *   status() · json() · setHeader() · write() · end() · on('close'|'finish')
 *   flushHeaders() · writableEnded · headersSent
 * `req` surface used:
 *   method · path · originalUrl · headers · header() · body
 */

const encoder = new TextEncoder()

type Listener = () => void

export interface ExpressLikeReq {
  method: string
  path: string
  originalUrl: string
  headers: Record<string, string>
  header(name: string): string | undefined
  body: unknown
}

/** Build an Express-ish request from a Web `Request`. Body is parsed once. */
export async function toExpressReq(request: Request, pathname: string): Promise<ExpressLikeReq> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })

  let body: unknown = undefined
  if (request.method !== "GET" && request.method !== "HEAD") {
    const ct = headers["content-type"] ?? ""
    if (ct.includes("application/json")) {
      try {
        const text = await request.text()
        body = text ? JSON.parse(text) : undefined
      } catch {
        body = undefined
      }
    }
  }

  return {
    method: request.method,
    path: pathname,
    originalUrl: pathname,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
    body,
  }
}

/**
 * An Express-`Response`-shaped shim whose writes feed a `ReadableStream`.
 * `getResponse()` resolves as soon as the headers are known (first
 * `write`/`flushHeaders`/`end`), so a streaming handler can return the response
 * immediately and keep writing the body afterwards.
 */
export class WebResShim {
  statusCode = 200
  headersSent = false
  writableEnded = false

  private headers = new Map<string, string>()
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private readable: ReadableStream<Uint8Array>
  private resolveResponse!: (r: Response) => void
  private responsePromise: Promise<Response>
  private closeListeners: Listener[] = []
  private finishListeners: Listener[] = []
  private closed = false

  constructor(signal?: AbortSignal) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => {
        this.fireClose()
      },
    })
    this.responsePromise = new Promise<Response>((resolve) => {
      this.resolveResponse = resolve
    })
    if (signal) {
      if (signal.aborted) this.fireClose()
      else signal.addEventListener("abort", () => this.fireClose(), { once: true })
    }
  }

  // ----- Express-compatible surface -----

  status(code: number): this {
    this.statusCode = code
    return this
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value))
    return this
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name.toLowerCase())
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase())
  }

  flushHeaders(): void {
    this.finalize()
  }

  json(payload: unknown): this {
    if (!this.headers.has("content-type")) {
      this.setHeader("content-type", "application/json; charset=utf-8")
    }
    this.end(JSON.stringify(payload))
    return this
  }

  write(chunk: string | Uint8Array | Buffer): boolean {
    if (this.writableEnded) return false
    this.finalize()
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk)
    try {
      this.controller?.enqueue(bytes)
    } catch {
      return false
    }
    return true
  }

  end(chunk?: string | Uint8Array | Buffer): void {
    if (this.writableEnded) return
    if (chunk != null) this.write(chunk)
    else this.finalize()
    this.writableEnded = true
    try {
      this.controller?.close()
    } catch {
      /* already closed */
    }
    this.fireFinish()
    this.fireClose()
  }

  on(event: "close" | "finish" | string, cb: Listener): this {
    if (event === "close") this.closeListeners.push(cb)
    else if (event === "finish") this.finishListeners.push(cb)
    return this
  }

  /** Resolves once headers are committed; the body may still be streaming. */
  getResponse(): Promise<Response> {
    return this.responsePromise
  }

  // ----- internals -----

  private finalize(): void {
    if (this.headersSent) return
    this.headersSent = true
    const headers = new Headers()
    for (const [k, v] of this.headers) headers.set(k, v)
    // 101/204/205/304 are forbidden a body by the Fetch spec — passing a stream
    // (even an empty one) makes the Response constructor throw.
    const nullBody = this.statusCode === 101 || this.statusCode === 204 || this.statusCode === 205 || this.statusCode === 304
    this.resolveResponse(new Response(nullBody ? null : this.readable, { status: this.statusCode, headers }))
  }

  private fireFinish(): void {
    const ls = this.finishListeners
    this.finishListeners = []
    for (const l of ls) safe(l)
  }

  private fireClose(): void {
    if (this.closed) return
    this.closed = true
    const ls = this.closeListeners
    this.closeListeners = []
    for (const l of ls) safe(l)
  }
}

function safe(fn: Listener) {
  try {
    fn()
  } catch {
    /* ignore listener errors */
  }
}
