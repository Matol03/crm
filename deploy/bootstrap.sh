#!/usr/bin/env bash
# One-shot provisioner for a fresh Ubuntu 22.04/24.04 VPS (run as root).
#
# Usage — from your machine, ship the code then run this on the host:
#   rsync -av --exclude node_modules --exclude data --exclude logs \
#         --exclude .git ./ root@HOST:/tmp/lead-service/
#   ssh root@HOST 'bash /tmp/lead-service/deploy/bootstrap.sh'
#
# `.env` is NOT shipped by that rsync (it is excluded below on purpose) —
# install it separately so secrets never sit in a world-readable /tmp copy:
#   scp .env root@HOST:/opt/lead-service/.env
#   ssh root@HOST 'chmod 600 /opt/lead-service/.env && chown leadsvc /opt/lead-service/.env'
#
# Idempotent: safe to re-run to upgrade an existing install.

set -euo pipefail

APP_DIR=/opt/lead-service
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_USER=leadsvc

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

log "Installing Node 24 (node:sqlite is stable there; flag-gated on 22)"
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v

log "Creating service user '$SVC_USER'"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin "$SVC_USER"

log "Installing application to $APP_DIR"
mkdir -p "$APP_DIR"
# --delete keeps the install clean on re-run, but never touch runtime state.
rsync -a --delete \
  --exclude node_modules --exclude data --exclude logs --exclude .git --exclude .env \
  "$SRC_DIR"/ "$APP_DIR"/
mkdir -p "$APP_DIR/data" "$APP_DIR/logs"

log "Installing dependencies"
cd "$APP_DIR"
npm ci --omit=optional 2>/dev/null || npm install

chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR/data" "$APP_DIR/logs"
[[ -f "$APP_DIR/.env" ]] && chown "$SVC_USER" "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"

log "Installing systemd unit"
cp "$APP_DIR/deploy/lead-service.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable lead-service

if [[ ! -f "$APP_DIR/.env" ]]; then
  cat <<'MSG'

  .env is missing — the service will not start without it.
  Copy it up, then start the service:

    scp .env root@HOST:/opt/lead-service/.env
    ssh root@HOST 'chmod 600 /opt/lead-service/.env && chown leadsvc /opt/lead-service/.env'
    ssh root@HOST 'systemctl start lead-service'

MSG
  exit 0
fi

log "Starting service"
systemctl restart lead-service
sleep 3
systemctl --no-pager --lines=15 status lead-service || true

cat <<'MSG'

Done. Useful commands:
  journalctl -u lead-service -f        # follow logs
  systemctl restart lead-service       # restart
  systemctl stop lead-service          # stop (halts CRM writes)

MSG
