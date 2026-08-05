import { useMemo } from "react"
import { colors, radii, space } from "../tokens"
import { CopyButton } from "./CopyButton"
import { Section } from "./Section"

export function ConnectionDetails() {
  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return ""
    return window.location.origin
  }, [])
  const authHeader = "Authorization: Bearer 123"

  return (
    <Section
      title="Connection Details"
      description="Point any OpenAI- or Anthropic-compatible client at this gateway. The default Bearer token is 123 — change PROXY_API_KEY in production."
    >
      <div style={{ display: "grid", gap: space(3) }}>
        <Field label="Base URL" value={baseUrl} mono />
        <Field label="Authorization Header" value={authHeader} mono />
      </div>
    </Section>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(3),
        padding: space(3),
        background: colors.surface2,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 160, color: colors.muted, fontSize: 13, fontWeight: 500 }}>{label}</div>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "inherit",
          fontSize: 13,
          color: colors.text,
          background: "transparent",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={value}
      >
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  )
}
