import { colors, radii, space } from "../tokens"
import { Badge } from "./Badge"
import { Section } from "./Section"

interface Model {
  id: string
  provider: "OpenAI" | "Anthropic"
}

const models: Model[] = [
  { id: "gpt-5.2", provider: "OpenAI" },
  { id: "gpt-5-mini", provider: "OpenAI" },
  { id: "gpt-5-nano", provider: "OpenAI" },
  { id: "o4-mini", provider: "OpenAI" },
  { id: "o3", provider: "OpenAI" },
  { id: "claude-opus-4-6", provider: "Anthropic" },
  { id: "claude-sonnet-4-6", provider: "Anthropic" },
  { id: "claude-haiku-4-5", provider: "Anthropic" },
]

export function Models() {
  return (
    <Section
      title="Available Models"
      description="Every model below works through both /v1/chat/completions and /v1/messages — the gateway converts request and response shapes when needed."
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
            <Badge color={m.provider === "OpenAI" ? "blue" : "orange"} size="sm">
              {m.provider}
            </Badge>
          </div>
        ))}
      </div>
    </Section>
  )
}
