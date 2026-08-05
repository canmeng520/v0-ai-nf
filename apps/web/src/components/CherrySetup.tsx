import { useMemo } from "react"
import { colors, radii, space } from "../tokens"
import { Section } from "./Section"

interface Step {
  title: string
  body: React.ReactNode
}

export function CherrySetup() {
  const origin = useMemo(() => (typeof window !== "undefined" ? window.location.origin : ""), [])

  const steps: Step[] = [
    {
      title: "Open CherryStudio Settings",
      body: (
        <>
          Click the gear icon, then go to <strong style={{ color: colors.text }}>Model Providers</strong> and add a new
          custom provider.
        </>
      ),
    },
    {
      title: "Choose API Type: OpenAI",
      body: (
        <>
          Select <strong style={{ color: colors.text }}>OpenAI</strong> as the API type. This works for every supported
          model — the gateway handles Anthropic conversion automatically.
        </>
      ),
    },
    {
      title: "Set Base URL & API Key",
      body: (
        <>
          Use this gateway as the API host:
          <code
            style={{
              display: "block",
              marginTop: 6,
              padding: "6px 10px",
              background: colors.surface2,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.sm,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              color: colors.blue,
              wordBreak: "break-all",
            }}
          >
            {origin}
          </code>
          <span style={{ display: "block", marginTop: 6 }}>
            API Key: <code style={{ color: colors.purple, fontFamily: "ui-monospace, monospace" }}>123</code>
          </span>
        </>
      ),
    },
    {
      title: "Add Models & Chat",
      body: (
        <>
          Add any model id from the list above (e.g. <code style={{ color: colors.orange }}>claude-sonnet-4-6</code>{" "}
          or <code style={{ color: colors.orange }}>gpt-5-mini</code>). Save and start chatting.
        </>
      ),
    },
  ]

  return (
    <Section
      title="CherryStudio Setup"
      description="Use this proxy as a drop-in OpenAI provider. Anthropic models become available without any extra configuration."
    >
      <ol
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "grid",
          gap: space(3),
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        }}
      >
        {steps.map((s, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: space(3),
              padding: space(3),
              background: colors.surface2,
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                width: 32,
                height: 32,
                borderRadius: 999,
                background: `linear-gradient(135deg, ${colors.blue}, ${colors.purple})`,
                color: "#0d1117",
                fontWeight: 700,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
              }}
            >
              {i + 1}
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: colors.text }}>{s.title}</h3>
              <p style={{ margin: 0, color: colors.muted, fontSize: 13, lineHeight: 1.55 }}>{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}
