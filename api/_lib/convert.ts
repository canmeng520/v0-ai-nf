import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIToolCall,
  OpenAIContentPart,
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicImageBlock,
} from "./types.js"

// ---------- helpers ----------

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}

function dataUrlToAnthropicImage(url: string): AnthropicImageBlock {
  const m = /^data:([^;]+);base64,(.+)$/.exec(url)
  if (m) {
    return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
  }
  return { type: "image", source: { type: "url", url } }
}

// ---------- OpenAI request -> Anthropic request ----------

export function openaiToAnthropicRequest(req: OpenAIChatRequest): AnthropicMessagesRequest {
  // Extract system messages (combine into Anthropic top-level system)
  const systemTexts: string[] = []
  const nonSystem: OpenAIMessage[] = []
  for (const m of req.messages) {
    if (m.role === "system" || m.role === "developer") {
      const txt = stringifyOpenAIContent(m.content)
      if (txt) systemTexts.push(txt)
    } else {
      nonSystem.push(m)
    }
  }

  const messages: AnthropicMessage[] = []

  for (const m of nonSystem) {
    if (m.role === "tool") {
      // OpenAI sends tool result as its own message; Anthropic expects it
      // in a user message containing a tool_result block.
      const resultText = stringifyOpenAIContent(m.content) ?? ""
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: resultText,
      }
      // Coalesce with the previous message if it's a user/tool_result chain
      const prev = messages[messages.length - 1]
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block)
      } else {
        messages.push({ role: "user", content: [block] })
      }
      continue
    }

    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = []
      const text = stringifyOpenAIContent(m.content)
      if (text) blocks.push({ type: "text", text })
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
          } catch {
            input = { _raw: tc.function.arguments }
          }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
        }
      }
      messages.push({ role: "assistant", content: blocks.length ? blocks : "" })
      continue
    }

    // user
    const parts = openaiContentToAnthropicBlocks(m.content)
    messages.push({ role: "user", content: parts })
  }

  // Anthropic requires alternating roles; if first message is assistant, prepend a noop user
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: " " }] })
  }

  const max_tokens = req.max_completion_tokens ?? req.max_tokens ?? 4096

  const out: AnthropicMessagesRequest = {
    model: req.model,
    messages,
    max_tokens,
  }
  if (systemTexts.length) out.system = systemTexts.join("\n\n")
  if (req.temperature !== undefined) out.temperature = req.temperature
  if (req.top_p !== undefined) out.top_p = req.top_p
  if (req.stream !== undefined) out.stream = req.stream
  if (req.stop !== undefined) {
    out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  }
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    }))
  }
  if (req.tool_choice !== undefined) {
    if (req.tool_choice === "auto") out.tool_choice = { type: "auto" }
    else if (req.tool_choice === "required") out.tool_choice = { type: "any" }
    else if (req.tool_choice === "none") out.tool_choice = { type: "none" }
    else if (typeof req.tool_choice === "object")
      out.tool_choice = { type: "tool", name: req.tool_choice.function.name }
  }
  return out
}

function stringifyOpenAIContent(content: OpenAIMessage["content"]): string | null {
  if (content == null) return null
  if (typeof content === "string") return content
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n")
}

function openaiContentToAnthropicBlocks(content: OpenAIMessage["content"]): AnthropicContentBlock[] {
  if (content == null) return [{ type: "text", text: "" }]
  if (typeof content === "string") return [{ type: "text", text: content }]
  const blocks: AnthropicContentBlock[] = []
  for (const part of content as OpenAIContentPart[]) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text })
    else if (part.type === "image_url") blocks.push(dataUrlToAnthropicImage(part.image_url.url))
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" })
  return blocks
}

// ---------- Anthropic request -> OpenAI request ----------

export function anthropicToOpenaiRequest(req: AnthropicMessagesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = []

  if (req.system) {
    const sys = typeof req.system === "string" ? req.system : req.system.map((b) => b.text).join("\n\n")
    messages.push({ role: "system", content: sys })
  }

  for (const m of req.messages) {
    if (m.role === "user") {
      // user message can contain text/image/tool_result blocks. tool_result must
      // become separate `tool` messages in OpenAI format.
      const blocks: AnthropicContentBlock[] =
        typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content

      const userParts: OpenAIContentPart[] = []
      for (const b of blocks) {
        if (b.type === "text") userParts.push({ type: "text", text: b.text })
        else if (b.type === "image") {
          if (b.source.type === "base64") {
            userParts.push({
              type: "image_url",
              image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
            })
          } else if (b.source.type === "url") {
            userParts.push({ type: "image_url", image_url: { url: b.source.url } })
          }
        } else if (b.type === "tool_result") {
          const text =
            typeof b.content === "string"
              ? b.content
              : b.content
                  .map((c) => (c.type === "text" ? c.text : ""))
                  .filter(Boolean)
                  .join("\n")
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: text })
        }
      }
      if (userParts.length) {
        // collapse to plain string when possible
        const allText = userParts.every((p) => p.type === "text")
        if (allText) {
          messages.push({
            role: "user",
            content: userParts.map((p) => (p as { text: string }).text).join("\n"),
          })
        } else {
          messages.push({ role: "user", content: userParts })
        }
      }
      continue
    }

    // assistant
    const blocks: AnthropicContentBlock[] =
      typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content

    let textParts = ""
    const toolCalls: OpenAIToolCall[] = []
    for (const b of blocks) {
      if (b.type === "text") textParts += (textParts ? "\n" : "") + b.text
      else if (b.type === "thinking") {
        // skip thinking blocks - OpenAI has no equivalent in completions message
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        })
      }
    }
    const msg: OpenAIMessage = { role: "assistant", content: textParts || null }
    if (toolCalls.length) msg.tool_calls = toolCalls
    messages.push(msg)
  }

  const out: OpenAIChatRequest = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
  }
  if (req.temperature !== undefined) out.temperature = req.temperature
  if (req.top_p !== undefined) out.top_p = req.top_p
  if (req.stream !== undefined) out.stream = req.stream
  if (req.stop_sequences?.length) out.stop = req.stop_sequences
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }
  if (req.tool_choice) {
    if (req.tool_choice.type === "auto") out.tool_choice = "auto"
    else if (req.tool_choice.type === "any") out.tool_choice = "required"
    else if (req.tool_choice.type === "none") out.tool_choice = "none"
    else if (req.tool_choice.type === "tool" && req.tool_choice.name)
      out.tool_choice = { type: "function", function: { name: req.tool_choice.name } }
  }
  return out
}

// ---------- Anthropic response -> OpenAI response ----------

interface AnthropicResponse {
  id: string
  model: string
  role: "assistant"
  content: AnthropicContentBlock[]
  stop_reason: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

export function anthropicResponseToOpenai(resp: AnthropicResponse): unknown {
  let text = ""
  const toolCalls: OpenAIToolCall[] = []
  for (const b of resp.content ?? []) {
    if (b.type === "text") text += (text ? "\n" : "") + b.text
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })
    }
  }

  const finishReason = mapAnthropicStopReason(resp.stop_reason)
  const message: OpenAIMessage = {
    role: "assistant",
    content: text || null,
  }
  if (toolCalls.length) message.tool_calls = toolCalls

  const promptTokens = resp.usage?.input_tokens ?? 0
  const completionTokens = resp.usage?.output_tokens ?? 0

  return {
    id: resp.id?.replace(/^msg_/, "chatcmpl-") || makeId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length && finishReason === "stop" ? "tool_calls" : finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }
}

function mapAnthropicStopReason(r: string | null | undefined): "stop" | "length" | "tool_calls" | "content_filter" {
  switch (r) {
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "stop_sequence":
    case "end_turn":
    case null:
    case undefined:
      return "stop"
    default:
      return "stop"
  }
}

// ---------- OpenAI response -> Anthropic response ----------

interface OpenAIChatResponse {
  id: string
  model: string
  choices: Array<{
    index: number
    message: OpenAIMessage
    finish_reason: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export function openaiResponseToAnthropic(resp: OpenAIChatResponse): unknown {
  const choice = resp.choices?.[0]
  const msg = choice?.message
  const content: AnthropicContentBlock[] = []
  if (msg) {
    const text = stringifyOpenAIContent(msg.content)
    if (text) content.push({ type: "text", text })
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let input: Record<string, unknown> = {}
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = { _raw: tc.function.arguments }
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input })
      }
    }
  }

  const stop_reason = mapOpenaiFinishReason(choice?.finish_reason)

  return {
    id: resp.id?.replace(/^chatcmpl-/, "msg_") || makeId("msg"),
    type: "message",
    role: "assistant",
    model: resp.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
    },
  }
}

function mapOpenaiFinishReason(
  r: string | null | undefined,
): "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" {
  switch (r) {
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "stop":
    case null:
    case undefined:
      return "end_turn"
    default:
      return "end_turn"
  }
}

export const _internal = { stringifyOpenAIContent, makeId }
