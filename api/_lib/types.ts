// Minimal subset of OpenAI / Anthropic shapes we work with.

export type OpenAIRole = "system" | "user" | "assistant" | "tool" | "developer"

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAIMessage {
  role: OpenAIRole
  content?: string | OpenAIContentPart[] | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }

export interface OpenAITool {
  type: "function"
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  stream?: boolean
  stop?: string | string[]
  tools?: OpenAITool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown }
  user?: string
  reasoning_effort?: "low" | "medium" | "high"
  metadata?: Record<string, unknown>
}

export type AnthropicTextBlock = { type: "text"; text: string }
export type AnthropicImageBlock = {
  type: "image"
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string }
}
export type AnthropicToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export type AnthropicToolResultBlock = {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}
export type AnthropicThinkingBlock = { type: "thinking"; thinking: string; signature?: string }

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicMessagesRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string | AnthropicTextBlock[]
  max_tokens: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string }
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" }
  metadata?: { user_id?: string }
  /** Anthropic beta context-editing config. Native Anthropic accepts it; strict
   * non-native upstreams reject it as an unknown field, so it is stripped for
   * those. See `sanitizeAnthropicBody`. */
  context_management?: unknown
}
