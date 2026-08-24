# Deployment

## What this service needs from a host

It is **not** a web app: it is a long-running process that polls Microsoft Graph
on an interval and writes to Bitrix24. That rules out serverless/static hosts
(Vercel, Netlify, GitHub Pages) for the poller itself.

| Requirement | Why |
|---|---|
| Always-on process | Polling loop; a cold-start-per-request model cannot buffer sessions across an idle timer (S6). |
| Persistent disk | SQLite holds the idempotency ledger, lead state machine, and poll watermark. Losing it risks re-processing or silently skipping messages (S5/S10.4). |
| Node **24+** | `node:sqlite` is stable there (flag-gated on 22). |
| Outbound HTTPS | `login.microsoftonline.com`, `graph.microsoft.com`, the LLM provider, the Bitrix portal. |
| Env-var secrets | Graph client secret, Bitrix webhook URL, LLM key — never in the image or repo. |

No inbound ports are required for the poller. The optional ops view listens on
`API_PORT`, but it is gated only by a shared secret — keep it on localhost or
behind a VPN/reverse proxy with real auth.

## Option 0 — Vercel: the CONSOLE ONLY, in demo mode

`vercel.json` publishes `web/` as a static site. This is genuinely useful for
sharing the interface (a link anyone can open, no install), and it is all Vercel
can host: the poller is an always-on process and the API needs SQLite on a
persistent disk, neither of which exists on a serverless platform.

What a Vercel deployment shows: every screen, fully interactive, running on the
bundled demo fixtures — the "Demo data" pill in the header says so.
What it does NOT show: your real leads. The console has no service to read from
there, so nothing from Bitrix24 or Teams appears.

```bash
vercel login          # once
vercel --prod         # publishes web/ as a static site
```

For the working system — live leads, polling, CRM writes — use Option A or B.

## Option A — Docker (any VPS, Railway, Render, Fly.io)

```bash
docker compose up -d --build      # poller + optional ops view
docker compose logs -f poller
```

`.env` stays on the host (`.dockerignore` excludes it from the image). The
`lead-data` volume holds the SQLite database — **do not** run without it, or a
restart loses the watermark and the processed-message record.

On a managed platform (Railway/Render/Fly), set the same variables as
dashboard secrets and attach a persistent volume mounted at `/app/data`.

## Option B — Linux VPS, no Docker (scripted)

`deploy/bootstrap.sh` provisions a fresh Ubuntu 22.04/24.04 host end to end
(Node 24, service user, app install, dependencies, systemd unit) and is safe to
re-run to upgrade. Since the repo has no git remote yet, ship the code with
rsync:

```bash
rsync -av --exclude node_modules --exclude data --exclude logs --exclude .git \
      ./ root@HOST:/tmp/lead-service/
ssh root@HOST 'bash /tmp/lead-service/deploy/bootstrap.sh'

# Secrets travel separately, never through the world-readable /tmp copy:
scp .env root@HOST:/opt/lead-service/.env
ssh root@HOST 'chmod 600 /opt/lead-service/.env && chown leadsvc /opt/lead-service/.env'
ssh root@HOST 'systemctl start lead-service && journalctl -u lead-service -f'
```

## Option B2 — Linux VPS, manual

```bash
sudo useradd -r -s /usr/sbin/nologin leadsvc
sudo git clone <repo> /opt/lead-service && cd /opt/lead-service
sudo npm ci
sudo install -m 600 -o leadsvc .env /opt/lead-service/.env   # real secrets
sudo mkdir -p data logs && sudo chown leadsvc data logs
sudo cp deploy/lead-service.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now lead-service
journalctl -u lead-service -f
```

## Option C — Windows (current setup)

A scheduled task **LeadService** already runs `scripts/run-service.cmd` at logon
and restarts every 5 minutes if it stops. Adequate for a pilot; it stops when
the machine is off or the user is logged out, so it is not a production host.

## Pre-flight checklist

1. **Secrets rotated?** The Graph client secret, Bitrix webhook, and LLM key
   have all been shared in chat during development — rotate them before any
   production use, and set the new values only in the host's environment.
2. **LLM quota sufficient?** The Gemini free tier is ~20 requests/day/model
   (≈7-10 sessions). A real show needs paid billing or a funded DeepSeek
   account. Deploying does not change this.
3. **`BITRIX_MODE=live`** — confirm you intend real CRM writes.
4. **Campaign constants** (`CAMPAIGN_EXHIBITION`, `CAMPAIGN_SOURCE`) set for the
   current show.
5. **`employee_map` seeded** with manager email -> Bitrix user id, otherwise every
   lead falls back to the default owner with a warning.
6. **Graph permissions**: attachments need `Files.Read.All`; posting the reply to
   Teams needs `ChannelMessage.Send`. Without them the service still runs, but
   card photos/voice are flagged for retry and replies are only logged.
7. **Backups**: the SQLite file is the only local state worth keeping.
