export type Provider = "openai" | "anthropic"

export interface ModelInfo {
  id: string
  provider: Provider
  context_window: number
}

export const MODELS: ModelInfo[] = [
  // OpenAI
  { id: "gpt-5.2", provider: "openai", context_window: 400_000 },
  { id: "gpt-5-mini", provider: "openai", context_window: 400_000 },
  { id: "gpt-5-nano", provider: "openai", context_window: 400_000 },
  { id: "o4-mini", provider: "openai", context_window: 200_000 },
  { id: "o3", provider: "openai", context_window: 200_000 },
  // Anthropic
  { id: "claude-opus-4-6", provider: "anthropic", context_window: 200_000 },
  { id: "claude-sonnet-4-6", provider: "anthropic", context_window: 200_000 },
  { id: "claude-haiku-4-5", provider: "anthropic", context_window: 200_000 },
]

const MODEL_MAP = new Map(MODELS.map((m) => [m.id, m]))

export function getProvider(model: string): Provider {
  const exact = MODEL_MAP.get(model)
  if (exact) return exact.provider
  // Fallback by prefix
  if (/^claude/i.test(model)) return "anthropic"
  if (/^(gpt-|o\d|chatgpt)/i.test(model)) return "openai"
  // Default to OpenAI for unknown ids
  return "openai"
}

export function listModels() {
  return MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: 0,
    owned_by: m.provider,
    provider: m.provider,
    context_window: m.context_window,
  }))
}
