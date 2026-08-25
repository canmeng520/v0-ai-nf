import type { Response } from "express"
import { parseSseStream, writeSseData, writeSseDone, writeSseEvent } from "./sse.js"
import { redactUrls, redactErrorMessage } from "./redact.js"

// =============================================================
// Anthropic SSE -> OpenAI chat.completion.chunk SSE
// =============================================================

interface ToolCallSlot {
  index: number
  id: string
  name: string
  argsBuffer: string
}

export async function pipeAnthropicStreamToOpenai(
  upstream: ReadableStream<Uint8Array>,
  res: Response,
  model: string,
) {
  const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const created = Math.floor(Date.now() / 1000)

  // Map content_block index -> kind
  const blockKinds = new Map<number, "text" | "tool_use" | "thinking">()
  const toolSlots = new Map<number, ToolCallSlot>()
  let nextToolIndex = 0
  let roleSent = false
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null = null
  let usage: { prompt_tokens: number; completion_tokens: number } | null = null

  const sendChunk = (delta: Record<string, unknown>, finish?: string | null) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    }
    writeSseData(res, chunk)
  }

  try {
    for await (const ev of parseSseStream(upstream)) {
      if (!ev.data) continue
      let parsed: any
      try {
        parsed = JSON.parse(ev.data)
      } catch {
        continue
      }

      const type = parsed.type ?? ev.event
      switch (type) {
        case "message_start": {
          if (!roleSent) {
            roleSent = true
            sendChunk({ role: "assistant", content: "" })
          }
          if (parsed.message?.usage?.input_tokens != null) {
            usage = { prompt_tokens: parsed.message.usage.input_tokens, completion_tokens: 0 }
          }
          break
        }
        case "content_block_start": {
          const idx = parsed.index as number
          const block = parsed.content_block
          if (block?.type === "text") {
            blockKinds.set(idx, "text")
          } else if (block?.type === "thinking") {
            blockKinds.set(idx, "thinking")
          } else if (block?.type === "tool_use") {
            blockKinds.set(idx, "tool_use")
            const tIdx = nextToolIndex++
            toolSlots.set(idx, { index: tIdx, id: block.id, name: block.name, argsBuffer: "" })
            sendChunk({
              tool_calls: [
                {
                  index: tIdx,
                  id: block.id,
                  type: "function",
                  function: { name: block.name, arguments: "" },
                },
              ],
            })
          }
          break
        }
        case "content_block_delta": {
          const idx = parsed.index as number
          const kind = blockKinds.get(idx)
          const delta = parsed.delta
          if (!delta) break
          if (kind === "text" && delta.type === "text_delta") {
            sendChunk({ content: delta.text ?? "" })
          } else if (kind === "tool_use" && delta.type === "input_json_delta") {
            const slot = toolSlots.get(idx)
            if (slot && typeof delta.partial_json === "string") {
              slot.argsBuffer += delta.partial_json
              sendChunk({
                tool_calls: [
                  {
                    index: slot.index,
                    function: { arguments: delta.partial_json },
                  },
                ],
              })
            }
          }
          // ignore thinking_delta - not represented in OpenAI chat.completion stream
          break
        }
        case "content_block_stop":
          break
        case "message_delta": {
          const sr = parsed.delta?.stop_reason
          if (sr === "max_tokens") finishReason = "length"
          else if (sr === "tool_use") finishReason = "tool_calls"
          else if (sr) finishReason = "stop"
          if (parsed.usage?.output_tokens != null && usage) {
            usage.completion_tokens = parsed.usage.output_tokens
          }
          break
        }
        case "message_stop":
          break
        case "error": {
          const errPayload = {
            error: {
              message: redactUrls(parsed.error?.message ?? "upstream error"),
              type: parsed.error?.type ?? "upstream_error",
            },
          }
          writeSseData(res, errPayload)
          break
        }
        case "ping":
          // no-op
          break
        default:
          break
      }
    }

    // Final chunk with finish_reason
    sendChunk({}, finishReason ?? "stop")
    writeSseDone(res)
  } catch (err) {
    writeSseData(res, {
      error: { message: redactErrorMessage(err), type: "stream_error" },
    })
    writeSseDone(res)
  } finally {
    if (!res.writableEnded) res.end()
  }
}

// =============================================================
// OpenAI SSE -> Anthropic message stream SSE
// =============================================================

interface OAToolSlot {
  blockIndex: number
  id: string
  name: string
  started: boolean
}

export async function pipeOpenaiStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  res: Response,
  model: string,
) {
  const messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  let messageStartSent = false
  let textBlockIndex: number | null = null
  let textBlockOpen = false
  let nextBlockIndex = 0
  const toolSlots = new Map<number, OAToolSlot>() // OpenAI tool_calls index -> slot
  let stopReason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" = "end_turn"
  let promptTokens = 0
  let completionTokens = 0

  const send = (event: string, data: Record<string, unknown>) => {
    writeSseEvent(res, event, JSON.stringify({ type: event, ...data }))
  }

  const ensureMessageStart = () => {
    if (messageStartSent) return
    messageStartSent = true
    send("message_start", {
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const closeOpenBlocks = () => {
    if (textBlockOpen && textBlockIndex !== null) {
      send("content_block_stop", { index: textBlockIndex })
      textBlockOpen = false
    }
    for (const slot of toolSlots.values()) {
      if (slot.started) {
        send("content_block_stop", { index: slot.blockIndex })
        slot.started = false
      }
    }
  }

  try {
    for await (const ev of parseSseStream(upstream)) {
      if (!ev.data) continue
      if (ev.data === "[DONE]") break
      let chunk: any
      try {
        chunk = JSON.parse(ev.data)
      } catch {
        continue
      }
      ensureMessageStart()

      // Some upstreams send a usage-only chunk at the end
      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === "number") promptTokens = chunk.usage.prompt_tokens
        if (typeof chunk.usage.completion_tokens === "number") completionTokens = chunk.usage.completion_tokens
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      const finish = choice.finish_reason as string | null | undefined

      // Text delta
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (textBlockIndex === null) {
          textBlockIndex = nextBlockIndex++
          send("content_block_start", {
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          })
          textBlockOpen = true
        }
        send("content_block_delta", {
          index: textBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        })
      }

      // Tool call deltas
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const oaIndex = typeof tc.index === "number" ? tc.index : 0
          let slot = toolSlots.get(oaIndex)
          if (!slot) {
            slot = {
              blockIndex: nextBlockIndex++,
              id: tc.id ?? `toolu_${Date.now().toString(36)}_${oaIndex}`,
              name: tc.function?.name ?? "",
              started: false,
            }
            toolSlots.set(oaIndex, slot)
          } else {
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.name = tc.function.name
          }
          if (!slot.started && slot.name) {
            send("content_block_start", {
              index: slot.blockIndex,
              content_block: { type: "tool_use", id: slot.id, name: slot.name, input: {} },
            })
            slot.started = true
          }
          if (slot.started && typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
            send("content_block_delta", {
              index: slot.blockIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments },
            })
          }
        }
      }

      if (finish) {
        if (finish === "length") stopReason = "max_tokens"
        else if (finish === "tool_calls") stopReason = "tool_use"
        else if (finish === "stop") stopReason = "end_turn"
        else stopReason = "end_turn"
      }
    }

    ensureMessageStart()
    closeOpenBlocks()
    send("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: promptTokens, output_tokens: completionTokens },
    })
    send("message_stop", {})
  } catch (err) {
    send("error", { error: { type: "stream_error", message: redactErrorMessage(err) } })
  } finally {
    if (!res.writableEnded) res.end()
  }
}
