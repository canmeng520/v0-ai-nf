import { colors, space } from "./tokens"
import { Header } from "./components/Header"
import { ConnectionDetails } from "./components/ConnectionDetails"
import { Endpoints } from "./components/Endpoints"
import { Models } from "./components/Models"
import { CherrySetup } from "./components/CherrySetup"
import { CurlExample } from "./components/CurlExample"

export function App() {
  return (
    <main
      style={{
        minHeight: "100%",
        background: colors.bg,
        color: colors.text,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          padding: `${space(8)}px ${space(5)}px ${space(10)}px`,
        }}
      >
        <Header />
        <ConnectionDetails />
        <Endpoints />
        <Models />
        <CherrySetup />
        <CurlExample />
        <footer
          style={{
            textAlign: "center",
            color: colors.muted,
            fontSize: 13,
            paddingTop: space(6),
            borderTop: `1px solid ${colors.border}`,
            marginTop: space(4),
          }}
        >
          Powered by v0 AI Integrations · OpenAI SDK · Anthropic SDK · Express
        </footer>
      </div>
    </main>
  )
}
