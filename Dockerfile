FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV BRAIN_DB=/data/brain.db
ENV BRAIN_LOG_DIR=/data/logs
ENV BRAIN_TOKENS_FILE=/data/tokens.json
# One process, two listeners. The public one (bearer tokens; /mcp, /api/v1/<verb> and the OpenAPI
# document only) takes 4747, the single exposed port. The loopback one (graph page, admin routes)
# moves to 4748 inside the container and is never exposed.
ENV BRAIN_PORT=4748 BRAIN_PUBLIC_PORT=4747

EXPOSE 4747
VOLUME /data

# ponytail: runs as root because a fresh volume is root-owned; a non-root user needs an entrypoint
# that chowns /data first.

# No curl in the slim image, so the probe is node's built-in fetch against the unauthenticated spec.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/api/v1/openapi.json').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node as PID 1 (not `npm start`) so SIGTERM reaches the server's own shutdown handler.
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.ts"]
