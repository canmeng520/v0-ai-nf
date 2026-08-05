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

export function startKeepalive(res: Response, intervalMs = 5000) {
  const id = setInterval(() => {
    if (res.writableEnded) return
    try {
      res.write(`: keepalive\n\n`)
    } catch {
      // ignore
    }
  }, intervalMs)
  const stop = () => clearInterval(id)
  res.on("close", stop)
  res.on("finish", stop)
  return stop
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
 * Generic line-delimited SSE parser. Yields { event?, data } objects.
 * Multiple `data:` lines are joined with `\n`. Empty lines flush the buffer.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
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
    const { value, done } = await reader.read()
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
