import type { Response } from "express"

export function setSseHeaders(res: Response) {
  res.status(200)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache, no-transform")
  res.setHeader("Connection", "keep-alive")
  res.setHeader("X-Accel-Buffering", "no")
  // Flush headers immediately so clients see the stream start
  res.flushHeaders?.()
}

/** Client-facing stream protocol — determines the keepalive shape. */
export type StreamFormat = "openai" | "anthropic"

/**
 * Heartbeat sent while waiting for upstream data. It MUST be innocuous to the
 * client's SSE parser. A bare `:` comment is fine for OpenAI clients, but strict
 * Anthropic clients (e.g. new-api) mis-parse a comment line and try to JSON-decode
 * "keepalive" → `invalid character 'k'`. Anthropic streams therefore get a real
 * `ping` event instead. Anthropic's own API sends these, so every parser ignores it.
 */
function heartbeatPayload(format: StreamFormat): string {
  return format === "anthropic" ? `event: ping\ndata: {"type": "ping"}\n\n` : `: keepalive\n\n`
}

export function startKeepalive(res: Response, format: StreamFormat = "openai", intervalMs = 5000, immediate = false) {
  const payload = heartbeatPayload(format)
  // Flush one heartbeat right away when asked — guarantees a body byte reaches
  // the hosting edge the instant we open the stream (before any upstream data),
  // so an idle-stream watchdog can't cut a reasoning model's long first-token pause.
  if (immediate) {
    try {
      res.write(payload)
    } catch {
      // ignore
    }
  }

  // Suppress heartbeats while real data is flowing (sub2api's pattern): wrap
  // res.write once so every write stamps lastWrite, and only ping when the
  // stream has been idle for a full interval. Saves bytes and avoids pointless
  // pings interleaved into an active stream.
  let lastWrite = Date.now()
  const origWrite = res.write.bind(res) as (...args: unknown[]) => boolean
  ;(res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    lastWrite = Date.now()
    return origWrite(...args)
  }

  const id = setInterval(() => {
    if (res.writableEnded) return
    if (Date.now() - lastWrite < intervalMs) return
    try {
      origWrite(payload)
      lastWrite = Date.now()
    } catch {
      // ignore
    }
  }, intervalMs)
  const stop = () => clearInterval(id)
  res.on("close", stop)
  res.on("finish", stop)
  return stop
}

/** Stall watchdog window for upstream streams (sub2api `stream_data_interval_timeout`).
 * `STREAM_STALL_TIMEOUT_MS` overrides; `0` disables. */
export function stallTimeoutMs(): number {
  const v = Number(process.env.STREAM_STALL_TIMEOUT_MS)
  if (Number.isFinite(v)) return Math.max(0, v)
  return 90_000
}

/**
 * `reader.read()` raced against a stall timer. Returns "stall" when the upstream
 * produced nothing for `ms` (0 disables the watchdog). The pending read is left
 * to the caller to cancel via `safeCancel(reader)`.
 */
export async function readWithStall<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>> | "stall"> {
  if (!ms) return reader.read()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stall = new Promise<"stall">((resolve) => {
    timer = setTimeout(() => resolve("stall"), ms)
  })
  try {
    return await Promise.race([reader.read(), stall])
  } finally {
    clearTimeout(timer)
  }
}

export function writeSseEvent(res: Response, eventName: string | null, data: string) {
  if (res.writableEnded) return
  let payload = ""
  if (eventName) payload += `event: ${eventName}\n`
  for (const line of data.split("\n")) {
    payload += `data: ${line}\n`
  }
  payload += "\n"
  res.write(payload)
}

export function writeSseData(res: Response, json: unknown) {
  writeSseEvent(res, null, JSON.stringify(json))
}

export function writeSseDone(res: Response) {
  if (res.writableEnded) return
  res.write(`data: [DONE]\n\n`)
}

/**
 * Cancel an upstream stream (or its reader) without ever surfacing an error.
 * `cancel()` on a stream whose reader is already locked (our SSE parser owns it)
 * throws synchronously on some engines and returns a REJECTED promise on others;
 * both are swallowed here so a client disconnect can't produce an unhandled
 * rejection that aborts the response.
 */
export function safeCancel(
  target: { cancel(reason?: unknown): Promise<void> } | null | undefined,
): void {
  try {
    const p = target?.cancel?.()
    if (p && typeof (p as Promise<void>).then === "function") {
      ;(p as Promise<void>).catch(() => {
        /* ignore */
      })
    }
  } catch {
    /* ignore */
  }
}

/**
 * Generic line-delimited SSE parser. Yields { event?, data } objects.
 * Multiple `data:` lines are joined with `\n`. Empty lines flush the buffer.
 * Throws when the upstream stalls past STREAM_STALL_TIMEOUT_MS — the converting
 * pipes' existing catch blocks turn that into a protocol-correct stream error.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const stallMs = stallTimeoutMs()
  let buf = ""
  let event: string | null = null
  let dataLines: string[] = []

  const flush = () => {
    if (dataLines.length === 0 && event === null) return null
    const out = { event, data: dataLines.join("\n") }
    event = null
    dataLines = []
    return out
  }

  while (true) {
    const result = await readWithStall(reader, stallMs)
    if (result === "stall") {
      safeCancel(reader)
      throw new Error(`upstream stream stalled (no data for ${Math.round(stallMs / 1000)}s)`)
    }
    const { value, done } = result
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let idx: number
    while ((idx = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)

      if (line === "") {
        const ev = flush()
        if (ev) yield ev
        continue
      }
      if (line.startsWith(":")) continue // comment / keepalive
      const colon = line.indexOf(":")
      const field = colon === -1 ? line : line.slice(0, colon)
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "event") event = value
      else if (field === "data") dataLines.push(value)
    }
  }
  // tail flush
  if (buf.length) {
    // try to handle final line without trailing newline
    const line = buf.endsWith("\r") ? buf.slice(0, -1) : buf
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""))
    else if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "")
  }
  const tail = flush()
  if (tail) yield tail
}
