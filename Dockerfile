# Trade-show lead service — continuous Teams -> Bitrix24 poller.
#
# Node 24: `node:sqlite` is stable here (it is flag-gated on Node 22), so the
# database layer needs no native build step and no extra flags.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first so layer caching survives source edits.
# NOTE: do not pass --omit=optional — rollup (via vitest) ships its native
# binary as a platform-specific OPTIONAL dependency, and omitting it breaks the
# test run inside the image. The lockfile is resolved for the image's platform.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Application source. Secrets are NEVER baked in — they come from the runtime
# environment (see .dockerignore, which excludes .env).
COPY tsconfig.json ./
COPY server ./server
COPY scripts ./scripts
COPY web ./web
COPY fixtures ./fixtures

# SQLite state (sessions, idempotency ledger, lead state machine) must outlive
# the container — mount a volume here or restarts lose the watermark and the
# already-processed record.
VOLUME ["/app/data"]
ENV DB_PATH=/app/data/prod.sqlite

# Prefer IPv4 when resolving. Node's fetch (undici) tries IPv6 first, and on any
# host where IPv6 egress is advertised but not actually routable every outbound
# call hangs until ETIMEDOUT — the service then looks "stuck" with no error.
# Verified: without this the container could not reach graph.microsoft.com; with
# it, the same call returns 200.
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# The poller is the main process; the ops view is a separate command
# (npm run start:api) if you want it exposed.
CMD ["npx", "tsx", "scripts/poll-teams.ts", "--watch"]
