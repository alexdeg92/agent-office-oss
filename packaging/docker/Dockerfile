# Agent Office image. Build from the repo root:
#   docker build -f packaging/docker/Dockerfile -t agent-office:local .
# The runtime image contains the API, the v2 UI, and the CLI. It does not contain the legacy public/ UI.
# No secrets belong in this file or in the image.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js gateway.js ./
COPY src ./src
COPY public/v2 ./public/v2
COPY scripts ./scripts
COPY packaging ./packaging
COPY integrations/openclaw/projet ./integrations/openclaw/projet
COPY LICENSE README.md .env.example ./
COPY design ./design
COPY docs/architecture/examples ./docs/architecture/examples
RUN node scripts/build-frontend.js \
  && node -e 'require("./packaging/release-tools").stagePackage(process.cwd(), "/stage")' \
  && cd /stage && npm pack --json > /app/pack.json \
  && mkdir /runtime && tar -xzf *.tgz --strip-components=1 -C /runtime


FROM node:24-slim
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/alexdeg92/agent-office-oss" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    AO_DATA_DIR=/data \
    AO_CONFIG=/config/config.json \
    HOST=0.0.0.0 \
    PORT=18789
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin ao \
  && mkdir -p /data /config \
  && chown ao:ao /data /config
COPY --from=build --chown=ao:ao /app/node_modules ./node_modules
COPY --from=build --chown=ao:ao /runtime ./
USER ao
VOLUME ["/data", "/config"]
EXPOSE 18789
# Default start is one port: UI at /, API at /backend. AO_API_ONLY=1 (compose, or start --api-only) listens at /api.
# G8 (docs/architecture/operations.md §1): the liveness probe, at the root (API-only) or behind /backend (one port).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.PORT||18789;const urls=['/healthz','/backend/healthz'];(async()=>{for(const u of urls){try{const r=await fetch('http://127.0.0.1:'+p+u);if(r.ok)process.exit(0)}catch{}}process.exit(1)})()"
ENTRYPOINT ["node", "--", "packaging/bin/agent-office.js"]
CMD ["start"]
