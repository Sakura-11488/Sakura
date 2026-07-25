#!/usr/bin/env bash
#
# Deploy / update the Sakura Comics scraper on the DigitalOcean droplet.
#
# Run on the droplet (as root) from inside this directory:
#     bash deploy.sh
#
# It will:
#   1. Install Node 20 and PM2 if missing
#   2. Copy the service into /opt/sakura/comics-scraper
#   3. Install npm dependencies
#   4. Start (or reload) the PM2 process
#   5. Patch nginx with the /comics/v1/ proxy snippet if not present
#   6. Reload nginx
#   7. Health-check the endpoint

set -euo pipefail

APP_DIR="/opt/sakura/comics-scraper"
NGINX_SITE="/etc/nginx/sites-available/psyopanime"
NGINX_SNIPPET_MARKER="# >>> sakura comics scraper >>>"
PORT="${COMICS_SCRAPER_PORT:-3100}"

log() { printf '[comics-deploy] %s\n' "$*"; }

log "ensuring Node.js 20 is installed"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v(2[0-9]|[3-9][0-9])\.'; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

log "ensuring PM2 is installed"
if ! command -v pm2 >/dev/null 2>&1; then
    npm install -g pm2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "syncing source to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
    --exclude node_modules \
    --exclude 'proxy-template*.txt' \
    --exclude 'image-proxy-template*.txt' \
    --exclude img-cache \
    "$SCRIPT_DIR/" "$APP_DIR/"

cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

log "starting / reloading PM2 process"
if pm2 describe sakura-comics-scraper >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs
else
    pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

if [[ -f "$NGINX_SITE" ]] && ! grep -q "location /comics/v1/" "$NGINX_SITE"; then
    log "patching nginx site ($NGINX_SITE) with /comics/v1/ proxy snippet"
    tmp="$(mktemp)"
    # Insert the snippet *before* the first top-level `}` (the closing brace of
    # the server block). This keeps the new location {} inside the server {}.
    awk -v marker="$NGINX_SNIPPET_MARKER" -v snippet="$SCRIPT_DIR/nginx-snippet.conf" '
        BEGIN { inserted = 0 }
        {
            if (!inserted && $0 ~ /^}[[:space:]]*$/) {
                print marker
                while ((getline line < snippet) > 0) print line
                print "# <<< sakura comics scraper <<<"
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
        exit 0
    fi
    sleep 1
done

log "WARN: health check did not return 200. Check 'pm2 logs sakura-comics-scraper' for details."
exit 1
