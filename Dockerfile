FROM node:22-alpine

# tzdata so TZ (used by the digest schedule) works; wget is already in busybox for the healthcheck.
RUN apk add --no-cache tzdata

WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Jerusalem \
    DATABASE_PATH=/data/agent.sqlite \
    PORT=3000

# Dependencies first so this layer is cached until package files change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# The SQLite file lives on a mounted volume so approvals and usage survive restarts.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

# tsx runs the TypeScript directly (no build step). The flag only hides node:sqlite's experimental notice.
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/index.ts"]
