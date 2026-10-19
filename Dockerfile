# Self-hosted gateway API (dev-server.ts), built by .github/workflows/image.yml
# and hot-swapped on the VPS by the ai-proxy-ops updater. Node >= 22.12 for
# listen({ reusePort }).
FROM node:22-bookworm-slim
RUN npm i -g pnpm@9.12.0 && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter ai-proxy-gateway && pnpm store prune
COPY tsconfig.json dev-server.ts ./
COPY api ./api
LABEL ai-proxy=1
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "dev-server.ts"]
