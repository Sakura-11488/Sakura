#!/usr/bin/env bash
#
# Deploy / update the Sakura media ingest service on the DigitalOcean droplet.
#
# Run on the droplet (as root) from inside this directory:
#     MEDIA_INGEST_TOKEN=... bash deploy.sh
#
# It will:
#   1. Install Node 20, PM2, and ffmpeg if missing
#   2. Copy the service into /opt/sakura/media-ingest
#   3. Write /etc/sakura/media-ingest.env (token + Supabase config) if absent
#   4. Start (or reload) the PM2 process
#   5. Patch nginx with the /media/v1/ + /creator-media/ snippet if not present
#   6. Reload nginx and health-check the endpoint

set -euo pipefail

APP_DIR="/opt/sakura/media-ingest"
ENV_FILE="/etc/sakura/media-ingest.env"
NGINX_SITE="/etc/nginx/sites-available/psyopanime"
NGINX_SNIPPET_MARKER="# >>> sakura media ingest >>>"
PORT="${MEDIA_INGEST_PORT:-3200}"

log() { printf '[media-ingest-deploy] %s\n' "$*"; }

log "ensuring Node.js 20 is installed"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

log "ensuring PM2 is installed"
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
fi

log "ensuring ffmpeg is installed"
if ! command -v ffmpeg >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y ffmpeg
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "syncing source to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
    --exclude node_modules \
    "$SCRIPT_DIR/" "$APP_DIR/"

cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -z "${MEDIA_INGEST_TOKEN:-}" ]]; then
        log "ERROR: $ENV_FILE does not exist and MEDIA_INGEST_TOKEN is not set."
        log "Re-run as: MEDIA_INGEST_TOKEN=\$(openssl rand -hex 32) bash deploy.sh"
        exit 1
    fi
    log "writing $ENV_FILE"
    mkdir -p "$(dirname "$ENV_FILE")"
    cat > "$ENV_FILE" <<EOF
MEDIA_INGEST_TOKEN=${MEDIA_INGEST_TOKEN}
EOF
    chmod 600 "$ENV_FILE"
fi

mkdir -p /var/www/sakura-originals /var/www/creator-media

log "starting / reloading PM2 process"
set -a; source "$ENV_FILE"; set +a
if pm2 describe sakura-media-ingest >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs --update-env
else
    pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

if [[ -f "$NGINX_SITE" ]] && ! grep -q "$NGINX_SNIPPET_MARKER" "$NGINX_SITE"; then
    log "patching nginx site ($NGINX_SITE) with media ingest snippet"
    tmp="$(mktemp)"
    awk -v marker="$NGINX_SNIPPET_MARKER" -v snippet="$SCRIPT_DIR/nginx-snippet.conf" '
        BEGIN { inserted = 0 }
        {
            if (!inserted && $0 ~ /^}[[:space:]]*$/) {
                print marker
                while ((getline line < snippet) > 0) print line
                print "# <<< sakura media ingest <<<"
                close(snippet)
                inserted = 1
            }
            print
        }
    ' "$NGINX_SITE" > "$tmp"
    mv "$tmp" "$NGINX_SITE"
fi

log "testing & reloading nginx"
nginx -t
systemctl reload nginx

log "health-checking http://127.0.0.1:${PORT}/healthz"
for i in 1 2 3 4 5; do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
        log "service is healthy"
        log "admin API:  POST http://<droplet>/media/v1/works/<slug>/episodes"
        exit 0
    fi
    sleep 1
done

log "WARN: health check did not return 200. Check 'pm2 logs sakura-media-ingest'."
exit 1
