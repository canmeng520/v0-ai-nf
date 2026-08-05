import { useEffect, useRef, useState } from "react"
import { colors, radii } from "../tokens"

interface Props {
  value: string
  label?: string
  size?: "sm" | "md"
  variant?: "default" | "ghost"
}

export function CopyButton({ value, label = "Copy", size = "md", variant = "default" }: Props) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // fallback
      const ta = document.createElement("textarea")
      ta.value = value
      ta.style.position = "fixed"
      ta.style.opacity = "0"
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand("copy")
      } catch {
        // ignore
      }
      document.body.removeChild(ta)
    }
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }

  const padX = size === "sm" ? 8 : 12
  const padY = size === "sm" ? 4 : 6
  const fontSize = size === "sm" ? 12 : 13

  const baseStyle: React.CSSProperties =
    variant === "ghost"
      ? {
          background: "transparent",
          border: `1px solid ${colors.border}`,
          color: colors.text,
        }
      : {
          background: colors.surface2,
          border: `1px solid ${colors.border}`,
          color: colors.text,
        }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      style={{
        ...baseStyle,
        padding: `${padY}px ${padX}px`,
        borderRadius: radii.sm,
        fontSize,
        fontWeight: 500,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        transition: "background 120ms, border-color 120ms, color 120ms",
        color: copied ? colors.green : baseStyle.color,
        borderColor: copied ? colors.green : (baseStyle.borderColor as string),
      }}
    >
      <CopyIcon size={size === "sm" ? 12 : 14} />
      {copied ? "Copied!" : label}
    </button>
  )
}

function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h7" />
    </svg>
  )
}
