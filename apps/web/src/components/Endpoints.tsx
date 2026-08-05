import { useMemo } from "react"
import { colors, radii, space } from "../tokens"
import { Badge } from "./Badge"
import { CopyButton } from "./CopyButton"
import { Section } from "./Section"

interface Endpoint {
  method: "GET" | "POST"
  path: string
  provider: "OpenAI" | "Anthropic" | "Both"
  description: string
}

const endpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/v1/models",
    provider: "Both",
    description: "List every model exposed through the gateway, with provider attribution.",
  },
  {
    method: "POST",
    path: "/v1/chat/completions",
    provider: "OpenAI",
    description: "OpenAI-compatible Chat Completions. Routes to OpenAI or auto-converts to Anthropic.",
  },
  {
    method: "POST",
    path: "/v1/messages",
    provider: "Anthropic",
    description: "Anthropic-compatible Messages. Routes to Anthropic or auto-converts to OpenAI.",
  },
]

export function Endpoints() {
  const origin = useMemo(() => (typeof window !== "undefined" ? window.location.origin : ""), [])

  return (
    <Section
      title="API Endpoints"
      description="All POST endpoints support stream: true (SSE) and stream: false. Authentication is required on every /v1/* route."
    >
      <div style={{ display: "grid", gap: space(3) }}>
        {endpoints.map((e) => (
          <EndpointCard key={e.path + e.method} endpoint={e} origin={origin} />
        ))}
      </div>
    </Section>
  )
}

function EndpointCard({ endpoint, origin }: { endpoint: Endpoint; origin: string }) {
  const fullUrl = `${origin}${endpoint.path}`
  const methodColor: "green" | "purple" = endpoint.method === "GET" ? "green" : "purple"
  const providerColor: "blue" | "orange" | "gray" =
    endpoint.provider === "OpenAI" ? "blue" : endpoint.provider === "Anthropic" ? "orange" : "gray"

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
      <div style={{ display: "flex", alignItems: "center", gap: space(2), flexWrap: "wrap" }}>
        <Badge color={methodColor}>{endpoint.method}</Badge>
        <code
          style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 14,
            color: colors.text,
            fontWeight: 600,
          }}
        >
          {endpoint.path}
        </code>
        <Badge color={providerColor}>{endpoint.provider}</Badge>
      </div>
      <p
        style={{
          flex: 1,
          minWidth: 240,
          margin: 0,
          color: colors.muted,
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {endpoint.description}
      </p>
      <CopyButton value={fullUrl} label="Copy URL" size="sm" variant="ghost" />
    </div>
  )
}
