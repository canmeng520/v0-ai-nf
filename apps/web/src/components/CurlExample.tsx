import { useMemo } from "react"
import { colors, radii, space } from "../tokens"
import { CopyButton } from "./CopyButton"
import { Section } from "./Section"

export function CurlExample() {
  const origin = useMemo(() => (typeof window !== "undefined" ? window.location.origin : "<base-url>"), [])

  const raw = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer 123" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Say hi in 5 words."}]
  }'`

  return (
    <Section
      title="Quick Test (curl)"
      description="Hit the OpenAI-style endpoint with an Anthropic model. The gateway handles the conversion both ways."
    >
      <div
        style={{
          background: "#010409",
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 12px",
            background: colors.surface2,
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <span style={{ fontSize: 12, color: colors.muted, fontWeight: 600, letterSpacing: 0.4 }}>BASH</span>
          <CopyButton value={raw} size="sm" variant="ghost" />
        </div>
        <pre
          style={{
            margin: 0,
            padding: space(4),
            overflowX: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            lineHeight: 1.65,
            color: colors.text,
          }}
        >
          <HighlightedCurl />
        </pre>
      </div>
    </Section>
  )
}

function HighlightedCurl() {
  const origin = typeof window !== "undefined" ? window.location.origin : "<base-url>"
  return (
    <code style={{ fontFamily: "inherit" }}>
      <span style={{ color: colors.green }}>curl</span>{" "}
      <span style={{ color: colors.orange }}>{origin}/v1/chat/completions</span>{" "}
      <span style={{ color: colors.muted }}>{"\\"}</span>
      {"\n  "}
      <span style={{ color: colors.blue }}>-H</span>{" "}
      <span style={{ color: "#a5d6ff" }}>{`"Authorization: Bearer 123"`}</span>{" "}
      <span style={{ color: colors.muted }}>{"\\"}</span>
      {"\n  "}
      <span style={{ color: colors.blue }}>-H</span>{" "}
      <span style={{ color: "#a5d6ff" }}>{`"Content-Type: application/json"`}</span>{" "}
      <span style={{ color: colors.muted }}>{"\\"}</span>
      {"\n  "}
      <span style={{ color: colors.blue }}>-d</span>{" "}
      <span style={{ color: "#a5d6ff" }}>{`'{`}</span>
      {"\n    "}
      <span style={{ color: colors.purple }}>{`"model"`}</span>
      <span style={{ color: colors.text }}>: </span>
      <span style={{ color: "#a5d6ff" }}>{`"claude-sonnet-4-6"`}</span>
      <span style={{ color: colors.text }}>,</span>
      {"\n    "}
      <span style={{ color: colors.purple }}>{`"messages"`}</span>
      <span style={{ color: colors.text }}>: [</span>
      <span style={{ color: colors.text }}>{`{`}</span>
      <span style={{ color: colors.purple }}>{`"role"`}</span>
      <span style={{ color: colors.text }}>: </span>
      <span style={{ color: "#a5d6ff" }}>{`"user"`}</span>
      <span style={{ color: colors.text }}>, </span>
      <span style={{ color: colors.purple }}>{`"content"`}</span>
      <span style={{ color: colors.text }}>: </span>
      <span style={{ color: "#a5d6ff" }}>{`"Say hi in 5 words."`}</span>
      <span style={{ color: colors.text }}>{`}`}</span>
      <span style={{ color: colors.text }}>]</span>
      {"\n  "}
      <span style={{ color: "#a5d6ff" }}>{`}'`}</span>
    </code>
  )
}
