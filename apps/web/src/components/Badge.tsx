import { colors, radii } from "../tokens"

interface Props {
  children: React.ReactNode
  color?: "blue" | "purple" | "green" | "orange" | "red" | "gray"
  size?: "sm" | "md"
}

const map: Record<NonNullable<Props["color"]>, { fg: string; bg: string }> = {
  blue: { fg: colors.blue, bg: "rgba(88, 166, 255, 0.12)" },
  purple: { fg: colors.purple, bg: "rgba(188, 140, 255, 0.12)" },
  green: { fg: colors.green, bg: "rgba(63, 185, 80, 0.14)" },
  orange: { fg: colors.orange, bg: "rgba(255, 166, 87, 0.14)" },
  red: { fg: colors.red, bg: "rgba(248, 81, 73, 0.14)" },
  gray: { fg: colors.muted, bg: "rgba(139, 148, 158, 0.14)" },
}

export function Badge({ children, color = "gray", size = "md" }: Props) {
  const tone = map[color]
  const padX = size === "sm" ? 6 : 8
  const padY = size === "sm" ? 2 : 3
  const fontSize = size === "sm" ? 11 : 12
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `${padY}px ${padX}px`,
        borderRadius: radii.sm,
        background: tone.bg,
        color: tone.fg,
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: 0.2,
        border: `1px solid ${tone.fg}33`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  )
}
