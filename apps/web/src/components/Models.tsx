import { useEffect, useState } from "react"
import { colors, radii, space } from "../tokens"
import { Badge } from "./Badge"
import { Section } from "./Section"

interface Model {
  id: string
  provider: "OpenAI" | "Anthropic" | "Other"
}

// Static fallback — shown until the live list loads, or if /v1/models is locked
// behind a non-default token.
const fallbackModels: Model[] = [
  { id: "gpt-5.2", provider: "OpenAI" },
  { id: "gpt-5-mini", provider: "OpenAI" },
  { id: "gpt-5-nano", provider: "OpenAI" },
  { id: "o4-mini", provider: "OpenAI" },
  { id: "o3", provider: "OpenAI" },
  { id: "claude-opus-4-6", provider: "Anthropic" },
  { id: "claude-sonnet-4-6", provider: "Anthropic" },
  { id: "claude-haiku-4-5", provider: "Anthropic" },
]

function toDisplayProvider(p: unknown): Model["provider"] {
  if (p === "openai") return "OpenAI"
  if (p === "anthropic") return "Anthropic"
  return "Other"
}

export function Models() {
  const [models, setModels] = useState<Model[]>(fallbackModels)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let cancelled = false
    // The docs page ships the default token; a custom PROXY_API_KEY simply keeps
    // the static fallback list.
    fetch("/v1/models", { headers: { authorization: "Bearer 123" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: { data?: Array<{ id: string; provider?: string; owned_by?: string }> }) => {
        if (cancelled || !Array.isArray(json.data) || json.data.length === 0) return
        setModels(
          json.data.map((m) => ({ id: m.id, provider: toDisplayProvider(m.provider ?? m.owned_by) })),
        )
        setLive(true)
      })
      .catch(() => {
        /* keep fallback list */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Section
      title="Available Models"
      description={
        live
          ? "Live list pulled from the configured upstream — every model below works through both /v1/chat/completions and /v1/messages."
          : "Every model below works through both /v1/chat/completions and /v1/messages — the gateway converts request and response shapes when needed."
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: space(3),
        }}
      >
        {models.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: space(2),
              padding: space(3),
              background: colors.surface2,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
            }}
          >
            <code
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
                color: colors.text,
                fontWeight: 600,
                wordBreak: "break-all",
              }}
            >
              {m.id}
            </code>
            <Badge color={m.provider === "OpenAI" ? "blue" : m.provider === "Anthropic" ? "orange" : "gray"} size="sm">
              {m.provider}
            </Badge>
          </div>
        ))}
      </div>
    </Section>
  )
}
