import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:8787"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    hmr: {
      clientPort: 443,
      protocol: "wss",
    },
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/v1": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
  },
})
