/**
 * Google Gemini native API ⇄ OpenAI chat/completions conversion.
 *
 * Lets Gemini-native clients (google-genai SDKs, Gemini CLI, plain REST) call
 * `POST /v1beta/models/{model}:generateContent` (and `:streamGenerateContent`)
 * against this proxy. The request is translated to an OpenAI chat request and
 * served by the normal chat pipeline, so any model the proxy serves (Gemini,
 * GPT, Claude) is reachable through the Gemini surface.
 *
 * Gemini 3 needs its thought signatures echoed back on multi-turn function
 * calling. The upstream's OpenAI surface carries them in
 * `extra_content.google.thought_signature`; natively they live on the part as
 * `thoughtSignature`. Both directions map one onto the other.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>

// ---------- errors ----------

const STATUS_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  408: "DEADLINE_EXCEEDED",
  409: "ABORTED",
  413: "INVALID_ARGUMENT",
  429: "RESOURCE_EXHAUSTED",
  499: "CANCELLED",
  500: "INTERNAL",
  501: "UNIMPLEMENTED",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
  529: "UNAVAILABLE",
}

/** Google-style error body: `{ error: { code, message, status } }`. */
export function geminiError(code: number, message: string) {
  return { error: { code, message, status: STATUS_NAMES[code] ?? (code >= 500 ? "INTERNAL" : "INVALID_ARGUMENT") } }
}

/** Re-shape an OpenAI/Anthropic-style error body from the chat pipeline. */
export function toGeminiError(status: number, text: string) {
  let message = text.trim() || `HTTP ${status}`
  try {
    const j = JSON.parse(text)
    message = String(j?.error?.message ?? j?.message ?? message)
  } catch {
    /* plain-text body */
  }
  return geminiError(status, message)
}

// ---------- path ----------

/** Split `gemini-3.5-flash:generateContent` (optionally `models/`-prefixed). */
export function parseModelAction(rest: string): { model: string; action: string | null } {
  const s = decodeURIComponent(rest).replace(/^models\//, "")
  const i = s.lastIndexOf(":")
  return i < 0 ? { model: s, action: null } : { model: s.slice(0, i), action: s.slice(i + 1) }
}

// ---------- request: Gemini → OpenAI ----------

/** Gemini's OpenAPI-subset schema (uppercase types, `nullable`) → JSON Schema. */
export function toJsonSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(toJsonSchema)
  if (!schema || typeof schema !== "object") return schema
  const out: Json = {}
  for (const [k, v] of Object.entries(schema)) {
    if (k === "nullable" || k === "propertyOrdering") continue
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase()
    else if (k === "properties" && v && typeof v === "object") {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([p, s]) => [p, toJsonSchema(s)]))
    } else out[k] = toJsonSchema(v)
  }
  return out
}

const textOf = (parts: any[] | undefined) =>
  (parts ?? []).filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("")

const isGeminiModel = (model: string) => /^(google\/)?gemini-/i.test(model)

/** One user/model turn's non-function parts → OpenAI content (string when text-only). */
function userContent(parts: any[]): string | Json[] | null {
  const out: Json[] = []
  for (const p of parts) {
    if (typeof p?.text === "string") {
      if (!p.thought) out.push({ type: "text", text: p.text })
    } else if (p?.inlineData?.data) {
      const mime = String(p.inlineData.mimeType || "application/octet-stream")
      if (/^audio\//i.test(mime)) {
        const sub = mime.split("/")[1].toLowerCase().replace(/^x-/, "")
        out.push({ type: "input_audio", input_audio: { data: p.inlineData.data, format: sub === "mpeg" ? "mp3" : sub } })
      } else {
        out.push({ type: "image_url", image_url: { url: `data:${mime};base64,${p.inlineData.data}` } })
      }
    } else if (p?.fileData?.fileUri) {
      out.push({ type: "image_url", image_url: { url: p.fileData.fileUri } })
    }
  }
  if (out.length === 0) return null
  return out.every((p) => p.type === "text") ? out.map((p) => p.text).join("") : out
}

export function geminiToOpenAIRequest(body: Json, model: string, stream: boolean): Json {
  const messages: Json[] = []

  const sys = body.systemInstruction ?? body.system_instruction
  if (sys) {
    const text = typeof sys === "string" ? sys : textOf(sys.parts)
    if (text) messages.push({ role: "system", content: text })
  }

  // Native functionResponse parts may omit the call id; pair them with the
  // preceding model turn's calls by name, in order.
  const pending = new Map<string, string[]>()
  const contents: any[] = Array.isArray(body.contents) ? body.contents : body.contents ? [body.contents] : []
  contents.forEach((c, ci) => {
    const parts: any[] = Array.isArray(c?.parts) ? c.parts : []
    if (c?.role === "model") {
      const msg: Json = { role: "assistant", content: textOf(parts) || null }
      const sig = parts.find((p) => typeof p?.text === "string" && p.thoughtSignature)?.thoughtSignature
      if (sig) msg.extra_content = { google: { thought_signature: sig } }
      const calls = parts.filter((p) => p?.functionCall)
      if (calls.length) {
        msg.tool_calls = calls.map((p, i) => {
          const id = String(p.functionCall.id ?? `call_${ci}_${i}`)
          const name = String(p.functionCall.name)
          pending.set(name, [...(pending.get(name) ?? []), id])
          const tc: Json = { id, type: "function", function: { name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }
          if (p.thoughtSignature) tc.extra_content = { google: { thought_signature: p.thoughtSignature } }
          return tc
        })
      }
      messages.push(msg)
      return
    }
    // user (or "function"/"tool") turn: tool results first, they must follow the calls.
    for (const p of parts.filter((p) => p?.functionResponse)) {
      const fr = p.functionResponse
      const name = String(fr.name ?? "")
      const id = String(fr.id ?? pending.get(name)?.shift() ?? `call_${name}`)
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response ?? {}) })
    }
    const content = userContent(parts.filter((p) => !p?.functionResponse))
    if (content !== null) messages.push({ role: "user", content })
  })

  const out: Json = { model, messages }
  const g: Json = body.generationConfig ?? body.generation_config ?? {}
  if (g.temperature != null) out.temperature = g.temperature
  if (g.topP != null) out.top_p = g.topP
  if (g.maxOutputTokens != null) out.max_tokens = g.maxOutputTokens
  if (Array.isArray(g.stopSequences) && g.stopSequences.length) out.stop = g.stopSequences
  if (g.candidateCount != null) out.n = g.candidateCount
  if (g.presencePenalty != null) out.presence_penalty = g.presencePenalty
  if (g.frequencyPenalty != null) out.frequency_penalty = g.frequencyPenalty
  if (g.seed != null) out.seed = g.seed
  const schema = g.responseJsonSchema ?? g.responseSchema
  if (schema) {
    out.response_format = { type: "json_schema", json_schema: { name: "response", schema: g.responseJsonSchema ?? toJsonSchema(schema) } }
  } else if (g.responseMimeType === "application/json") {
    out.response_format = { type: "json_object" }
  }
  // Thinking settings only mean something to Gemini; the upstream's OpenAI
  // surface takes them under extra_body.google (other providers would 400).
  const tc = g.thinkingConfig
  if (tc && isGeminiModel(model)) {
    const thinking_config: Json = {}
    if (tc.thinkingBudget != null) thinking_config.thinking_budget = tc.thinkingBudget
    if (tc.includeThoughts != null) thinking_config.include_thoughts = tc.includeThoughts
    if (tc.thinkingLevel != null) thinking_config.thinking_level = String(tc.thinkingLevel).toLowerCase()
    if (Object.keys(thinking_config).length) out.extra_body = { google: { thinking_config } }
  }

  // Function declarations only — built-in tools (googleSearch, codeExecution,
  // urlContext) have no OpenAI equivalent and are dropped.
  const fns: Json[] = []
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    for (const d of t?.functionDeclarations ?? t?.function_declarations ?? []) {
      fns.push({
        type: "function",
        function: {
          name: d.name,
          ...(d.description ? { description: d.description } : {}),
          parameters: d.parametersJsonSchema ?? (d.parameters ? toJsonSchema(d.parameters) : { type: "object", properties: {} }),
        },
      })
    }
  }
  if (fns.length) {
    out.tools = fns
    const fc = body.toolConfig?.functionCallingConfig
    const allowed: string[] = fc?.allowedFunctionNames ?? []
    if (fc?.mode === "NONE") out.tool_choice = "none"
    else if (fc?.mode === "ANY") out.tool_choice = allowed.length === 1 ? { type: "function", function: { name: allowed[0] } } : "required"
    else if (fc?.mode) out.tool_choice = "auto"
  }

  if (stream) {
    out.stream = true
    out.stream_options = { include_usage: true }
  }
  return out
}

// ---------- response: OpenAI → Gemini ----------

const FINISH: Record<string, string> = {
  stop: "STOP",
  length: "MAX_TOKENS",
  tool_calls: "STOP",
  function_call: "STOP",
  content_filter: "SAFETY",
}
export const finishReason = (r: string | null | undefined) => (r ? (FINISH[r] ?? "OTHER") : undefined)

export function usageMetadata(u: Json | undefined | null): Json | undefined {
  if (!u) return undefined
  const thoughts = u.completion_tokens_details?.reasoning_tokens ?? 0
  const prompt = u.prompt_tokens ?? 0
  const completion = u.completion_tokens ?? 0
  const total = u.total_tokens ?? prompt + completion
  // OpenAI counts reasoning inside completion_tokens (total = prompt + completion);
  // Gemini's OpenAI surface keeps it out (total = prompt + completion + reasoning).
  const reasoningInside = prompt + completion >= total
  const meta: Json = {
    promptTokenCount: prompt,
    candidatesTokenCount: reasoningInside ? Math.max(0, completion - thoughts) : completion,
    totalTokenCount: total,
  }
  if (thoughts) meta.thoughtsTokenCount = thoughts
  const cached = u.prompt_tokens_details?.cached_tokens
  if (cached) meta.cachedContentTokenCount = cached
  return meta
}

const sigOf = (x: Json | undefined) => x?.extra_content?.google?.thought_signature as string | undefined

function parseArgs(s: string | undefined): Json {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === "object" ? v : { value: v }
  } catch {
    return { _raw: s }
  }
}

/** OpenAI message content (string or parts) → Gemini parts. */
function contentParts(content: unknown): Json[] {
  if (typeof content === "string") return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []
  const out: Json[] = []
  for (const p of content as Json[]) {
    if (p?.type === "text" && typeof p.text === "string") out.push({ text: p.text })
    else if (p?.type === "image_url") {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(p.image_url?.url ?? ""))
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } })
    }
  }
  return out
}

// With includeThoughts the upstream's OpenAI surface inlines the reasoning as a
// leading `<think>…</think>` block in the content; Gemini clients expect it as
// separate `thought: true` parts.
const THINK_OPEN = "<think>"
const THINK_CLOSE = "</think>"

/** Split a leading think block off the first text part (non-streaming). */
function splitThink(parts: Json[]): Json[] {
  const first = parts[0]
  if (typeof first?.text !== "string" || !first.text.trimStart().startsWith(THINK_OPEN)) return parts
  const t = first.text.trimStart().slice(THINK_OPEN.length)
  const end = t.indexOf(THINK_CLOSE)
  if (end < 0) return [{ text: t, thought: true }, ...parts.slice(1)]
  const rest = t.slice(end + THINK_CLOSE.length).replace(/^\s+/, "")
  const answer: Json = { ...first, text: rest }
  return [{ text: t.slice(0, end).trim(), thought: true }, ...(rest || first.thoughtSignature ? [answer] : []), ...parts.slice(1)]
}

/**
 * Streaming counterpart of splitThink: the tags may be cut across deltas, so
 * hold back just enough text to recognise them.
 */
class ThinkSplitter {
  private mode: "detect" | "thought" | "text" = "detect"
  private buf = ""

  /** Feed a text delta; returns the parts ready to send. */
  push(s: string): Json[] {
    this.buf += s
    const out: Json[] = []
    if (this.mode === "detect") {
      const lead = this.buf.trimStart()
      if (lead.length < THINK_OPEN.length && THINK_OPEN.startsWith(lead)) return out
      if (lead.startsWith(THINK_OPEN)) {
        this.mode = "thought"
        this.buf = lead.slice(THINK_OPEN.length)
      } else {
        this.mode = "text"
      }
    }
    if (this.mode === "thought") {
      const end = this.buf.indexOf(THINK_CLOSE)
      if (end >= 0) {
        const thought = this.buf.slice(0, end)
        if (thought) out.push({ text: thought, thought: true })
        this.buf = this.buf.slice(end + THINK_CLOSE.length).replace(/^\s+/, "")
        this.mode = "text"
      } else {
        // Keep a tail that could be the start of the closing tag.
        const keep = THINK_CLOSE.length - 1
        if (this.buf.length > keep) {
          out.push({ text: this.buf.slice(0, -keep), thought: true })
          this.buf = this.buf.slice(-keep)
        }
        return out
      }
    }
    if (this.mode === "text" && this.buf) {
      out.push({ text: this.buf })
      this.buf = ""
    }
    return out
  }

  /** Whatever is still held back, at the end of the stream. */
  flush(): Json[] {
    const s = this.buf
    this.buf = ""
    if (!s) return []
    return [this.mode === "thought" ? { text: s, thought: true } : { text: s }]
  }
}

export function openAIToGeminiResponse(resp: Json, model: string): Json {
  const candidates = (resp.choices ?? []).map((ch: Json, i: number) => {
    const msg: Json = ch.message ?? {}
    const parts: Json[] = []
    const reasoning = msg.reasoning_content ?? msg.reasoning
    if (typeof reasoning === "string" && reasoning) parts.push({ text: reasoning, thought: true })
    const text = splitThink(contentParts(msg.content))
    const msgSig = sigOf(msg)
    if (msgSig) {
      const answer = text.find((p) => !p.thought)
      if (answer) answer.thoughtSignature = msgSig
      else text.push({ text: "", thoughtSignature: msgSig })
    }
    parts.push(...text)
    for (const tc of msg.tool_calls ?? []) {
      const part: Json = { functionCall: { id: tc.id, name: tc.function?.name, args: parseArgs(tc.function?.arguments) } }
      const s = sigOf(tc)
      if (s) part.thoughtSignature = s
      parts.push(part)
    }
    if (parts.length === 0) parts.push({ text: "" })
    return { content: { role: "model", parts }, finishReason: finishReason(ch.finish_reason) ?? "STOP", index: ch.index ?? i }
  })
  const out: Json = { candidates, modelVersion: resp.model ?? model }
  const usage = usageMetadata(resp.usage)
  if (usage) out.usageMetadata = usage
  if (resp.id) out.responseId = resp.id
  return out
}

/**
 * Stateful OpenAI stream-chunk → Gemini stream-chunk converter. Text deltas go
 * out as they arrive; tool calls are assembled across deltas and emitted with
 * the finish reason. Usage (sent after the finish chunk) rides on the last chunk.
 */
export class GeminiStreamConverter {
  private calls = new Map<number, Map<number, { id?: string; name: string; args: string; sig?: string }>>()
  private think = new Map<number, ThinkSplitter>()
  private finished: Json | null = null
  private usage: Json | undefined
  private responseId: string | undefined

  constructor(private model: string) {}

  private chunk(candidates: Json[]): Json {
    const c: Json = { candidates, modelVersion: this.model }
    if (this.responseId) c.responseId = this.responseId
    return c
  }

  /** Feed one parsed OpenAI chunk; returns the Gemini chunks to send now. */
  push(ev: Json): Json[] {
    if (ev.id) this.responseId = ev.id
    if (ev.usage) this.usage = usageMetadata(ev.usage)
    const out: Json[] = []
    for (const ch of ev.choices ?? []) {
      const idx = ch.index ?? 0
      const d: Json = ch.delta ?? {}
      const parts: Json[] = []
      const reasoning = d.reasoning_content ?? d.reasoning
      if (typeof reasoning === "string" && reasoning) parts.push({ text: reasoning, thought: true })
      const splitter = this.think.get(idx) ?? new ThinkSplitter()
      this.think.set(idx, splitter)
      // Streamed thought summaries arrive as their own deltas flagged
      // extra_content.google.thought (non-streaming inlines them as <think>).
      const flaggedThought = d.extra_content?.google?.thought === true
      const text: Json[] = []
      for (const p of contentParts(d.content)) {
        if (typeof p.text !== "string") text.push(p)
        else if (flaggedThought) { if (p.text) text.push({ text: p.text, thought: true }) }
        else text.push(...splitter.push(p.text))
      }
      if (ch.finish_reason) text.push(...splitter.flush())
      const sig = sigOf(d)
      if (sig) {
        const answer = text.find((p) => !p.thought)
        if (answer) answer.thoughtSignature = sig
        else text.push({ text: "", thoughtSignature: sig })
      }
      parts.push(...text)
      for (const tc of d.tool_calls ?? []) {
        const byIdx = this.calls.get(idx) ?? new Map()
        this.calls.set(idx, byIdx)
        const cur = byIdx.get(tc.index ?? 0) ?? { name: "", args: "" }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        const s = sigOf(tc)
        if (s) cur.sig = s
        byIdx.set(tc.index ?? 0, cur)
      }
      if (ch.finish_reason) {
        for (const c of [...(this.calls.get(idx)?.values() ?? [])]) {
          const part: Json = { functionCall: { id: c.id, name: c.name, args: parseArgs(c.args) } }
          if (c.sig) part.thoughtSignature = c.sig
          parts.push(part)
        }
        this.calls.delete(idx)
        this.think.delete(idx)
        // Held back so the usage that follows can ride on it.
        const cand = { content: { role: "model", parts: parts.length ? parts : [{ text: "" }] }, finishReason: finishReason(ch.finish_reason), index: idx }
        this.finished = this.finished ? { ...this.finished, candidates: [...this.finished.candidates, cand] } : this.chunk([cand])
        continue
      }
      if (parts.length) out.push(this.chunk([{ content: { role: "model", parts }, index: idx }]))
    }
    return out
  }

  /** Whether the upstream stream reached its end (a finish reason or the usage that follows it). */
  get completed(): boolean {
    return this.finished !== null || this.usage !== undefined
  }

  /** The held final chunk (finish reason + usage), if any. */
  end(): Json[] {
    // A stream that ended without a finish_reason may still hold text back.
    const tail: Json[] = []
    for (const [idx, s] of this.think) {
      const parts = s.flush()
      if (parts.length) tail.push(this.chunk([{ content: { role: "model", parts }, index: idx }]))
    }
    this.think.clear()
    const last = this.finished ?? (this.usage ? this.chunk([{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP", index: 0 }]) : null)
    if (!last) return tail
    if (this.usage) last.usageMetadata = this.usage
    return [...tail, last]
  }
}

// ---------- models ----------

export function geminiModelEntry(m: { id: string; context_window: number }) {
  return {
    name: `models/${m.id}`,
    baseModelId: m.id,
    version: "001",
    displayName: m.id,
    description: "",
    inputTokenLimit: m.context_window || 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
  }
}

/** Rough token estimate for :countTokens (no tokenizer for every provider). */
export function estimateTokens(body: Json): number {
  const req = body.generateContentRequest ?? body
  let chars = 0
  const walk = (v: unknown) => {
    if (typeof v === "string") chars += v.length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (k !== "inlineData" && k !== "thoughtSignature") walk(x)
    }
  }
  walk(req.contents)
  walk(req.systemInstruction)
  walk(req.tools)
  return Math.ceil(chars / 4)
}
