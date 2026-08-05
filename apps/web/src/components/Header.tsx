import { useEffect, useState } from "react"
import { colors, radii, space } from "../tokens"

type Status = "checking" | "online" | "offline"

export function Header() {
  const [status, setStatus] = useState<Status>("checking")

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch("/api/healthz", { cache: "no-store" })
        if (cancelled) return
        if (res.ok) {
          const json = await res.json().catch(() => null)
          setStatus(json?.status === "ok" ? "online" : "offline")
        } else {
          setStatus("offline")
        }
      } catch {
        if (!cancelled) setStatus("offline")
      }
    }
    check()
    const id = window.setInterval(check, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space(4),
        marginBottom: space(8),
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space(3) }}>
        <div
          aria-hidden="true"
          style={{
            width: 44,
            height: 44,
            borderRadius: radii.md,
            background: `linear-gradient(135deg, ${colors.blue}, ${colors.purple})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 14px rgba(88, 166, 255, 0.25)",
          }}
        >
          <BoltIcon />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: -0.4,
              color: colors.text,
            }}
          >
            AI Proxy API
          </h1>
          <span style={{ fontSize: 13, color: colors.muted }}>OpenAI + Anthropic unified gateway</span>
        </div>
      </div>

      <StatusPill status={status} />
    </header>
  )
}

function StatusPill({ status }: { status: Status }) {
  const conf =
    status === "online"
      ? { color: colors.green, label: "Online", bg: "rgba(63, 185, 80, 0.12)", border: "rgba(63, 185, 80, 0.4)" }
      : status === "offline"
        ? { color: colors.red, label: "Offline", bg: "rgba(248, 81, 73, 0.12)", border: "rgba(248, 81, 73, 0.4)" }
        : { color: colors.muted, label: "Checking…", bg: "rgba(139, 148, 158, 0.12)", border: colors.border }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 999,
        background: conf.bg,
        border: `1px solid ${conf.border}`,
        color: conf.color,
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: conf.color,
          boxShadow: status === "online" ? `0 0 0 4px rgba(63,185,80,0.18)` : "none",
        }}
      />
      {conf.label}
    </div>
  )
}

function BoltIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13.5 2.5L4 14h6l-1.5 7.5L20 10h-6l1.5-7.5z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}
