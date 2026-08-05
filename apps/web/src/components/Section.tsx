import { colors, radii, space } from "../tokens"

interface Props {
  title: string
  description?: string
  children: React.ReactNode
  id?: string
}

export function Section({ title, description, children, id }: Props) {
  return (
    <section
      id={id}
      style={{
        background: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.lg,
        padding: space(6),
        marginBottom: space(6),
      }}
    >
      <header style={{ marginBottom: space(4) }}>
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: colors.text,
            letterSpacing: -0.2,
          }}
        >
          {title}
        </h2>
        {description ? (
          <p style={{ margin: `${space(1)}px 0 0 0`, color: colors.muted, fontSize: 14, lineHeight: 1.5 }}>
            {description}
          </p>
        ) : null}
      </header>
      {children}
    </section>
  )
}
