# Trade-show lead service — continuous Teams -> Bitrix24 poller.
#
# Node 24: `node:sqlite` is stable here (it is flag-gated on Node 22), so the
# database layer needs no native build step and no extra flags.
FROM node:24-alpine

WORKDIR /app

# Install dependencies first so layer caching survives source edits.
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional || npm install

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

# The poller is the main process; the ops view is a separate command
# (npm run start:api) if you want it exposed.
CMD ["npx", "tsx", "scripts/poll-teams.ts", "--watch"]
