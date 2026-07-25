#!/usr/bin/env bash
#
# Deploy / update the Sakura Manhwa scraper on the DigitalOcean droplet.
#
# Run on the droplet (as root) from inside this directory:
#     bash deploy.sh
#
# It will:
#   1. Install Node 20 and PM2 if missing
#   2. Copy the service into /opt/sakura/manhwa-scraper
#   3. Install npm dependencies
#   4. Start (or reload) the PM2 process
#   5. Patch nginx with the /manhwa/v1/ proxy snippet if not present
#   6. Reload nginx
#   7. Health-check the endpoint

set -euo pipefail

APP_DIR="/opt/sakura/manhwa-scraper"
NGINX_SITE="/etc/nginx/sites-available/psyopanime"
NGINX_SNIPPET_MARKER="# >>> sakura manhwa scraper >>>"
PORT="${MANHWA_SCRAPER_PORT:-3102}"

log() { printf '[manhwa-deploy] %s\n' "$*"; }

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
    "$SCRIPT_DIR/" "$APP_DIR/"

cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

log "starting / reloading PM2 process"
if pm2 describe sakura-manhwa-scraper >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs
else
    pm2 start ecosystem.config.cjs
fi
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

if [[ -f "$NGINX_SITE" ]] && ! grep -q "$NGINX_SNIPPET_MARKER" "$NGINX_SITE"; then
    log "patching nginx site ($NGINX_SITE) with /manhwa/v1/ proxy snippet"
    tmp="$(mktemp)"
    # Insert the snippet before the LAST top-level `}` — the closing brace of
    # the server block — so the new location {} lands inside server {}.
    #
    # Not the *first* such brace: every snippet these deploy scripts add brings
    # its own column-0 `}`, so once a sibling scraper is installed the first
    # top-level brace is that sibling's location block, and anchoring there
    # nests the new location inside it. nginx then refuses to load with
    # 'location "/manhwa/v1/" is outside location "/hentai/v1/"'.
    awk -v marker="$NGINX_SNIPPET_MARKER" \
        -v closer="# <<< sakura manhwa scraper <<<" \
        -v snippet="$SCRIPT_DIR/nginx-snippet.conf" '
        { lines[NR] = $0; if ($0 ~ /^}[[:space:]]*$/) last = NR }
        END {
            if (last == 0) { exit 3 }
            for (i = 1; i <= NR; i++) {
                if (i == last) {
                    print marker
                    while ((getline line < snippet) > 0) print line
                    print closer
                    close(snippet)
                }
                print lines[i]
            }
        }
    ' "$NGINX_SITE" > "$tmp" || {
        rm -f "$tmp"
        log "ERROR: no top-level '}' found in $NGINX_SITE — patch it by hand"
        exit 1
    }
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

log "WARN: health check did not return 200. Check 'pm2 logs sakura-manhwa-scraper' for details."
exit 1
