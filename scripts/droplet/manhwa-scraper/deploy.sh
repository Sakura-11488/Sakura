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
PREV_DIR="/opt/sakura/manhwa-scraper.prev"
NGINX_SITE="/etc/nginx/sites-available/psyopanime"
NGINX_SNIPPET_MARKER="# >>> sakura manhwa scraper >>>"
PORT="${MANHWA_SCRAPER_PORT:-3102}"
# A series whose chapter list has to come back for the deploy to count.
READY_ID="${MANHWA_READY_ID:-mr:solo-leveling-manhwa}"

log() { printf '[manhwa-deploy] %s\n' "$*"; }

ROLLED_BACK=0
rollback_app() {
    [[ "$ROLLED_BACK" == "1" ]] && return 0
    ROLLED_BACK=1
    if [[ -d "$PREV_DIR" ]]; then
        log "ROLLING BACK to the previous release in $PREV_DIR"
        # node_modules included: the snapshot holds the previous release's
        # dependencies, and npm install has already replaced them with the new
        # package.json's by the time any gate fails. --checksum because npm
        # stamps every installed file with the same 1985 mtime, so a changed
        # file of unchanged size (a dependency's package.json after a patch
        # bump) passes rsync's size+mtime check and would not be restored.
        rsync -a --delete --checksum "$PREV_DIR/" "$APP_DIR/"
        # Restored ecosystem.config.cjs -> restored env, via --update-env; then
        # save, or a reboot resurrects the failed release's env from the dump.
        (cd "$APP_DIR" && pm2 reload ecosystem.config.cjs --update-env && pm2 save) || true
        log "rolled back."
    else
        log "no snapshot at $PREV_DIR; cannot auto-roll-back."
    fi
}

# Any failure once the new release starts landing in $APP_DIR (npm install,
# pm2, nginx -t, a gate) rolls back. Under `set -e` those used to exit with the
# new code on disk and possibly live, and the next run then snapshotted that
# broken release over the last good one.
RELEASE_LANDING=0
on_exit() {
    local rc=$?
    if [[ "$rc" != "0" && "$RELEASE_LANDING" == "1" ]]; then
        rollback_app
    fi
    exit "$rc"
}
trap on_exit EXIT

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

if [[ -d "$APP_DIR" ]]; then
    log "snapshotting the current release to $PREV_DIR"
    rm -rf "$PREV_DIR"
    cp -a "$APP_DIR" "$PREV_DIR"
fi

log "syncing source to $APP_DIR"
RELEASE_LANDING=1
mkdir -p "$APP_DIR"
rsync -a --delete \
    --exclude node_modules \
    "$SCRIPT_DIR/" "$APP_DIR/"

cd "$APP_DIR"

log "installing dependencies"
npm install --omit=dev --no-audit --no-fund

log "starting / reloading PM2 process"
if pm2 describe sakura-manhwa-scraper >/dev/null 2>&1; then
    # --update-env is required: without it pm2 keeps the environment captured
    # at first start, so every change to ecosystem.config.cjs (the request
    # timeouts included) is silently ignored.
    pm2 reload ecosystem.config.cjs --update-env
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
healthy=0
for i in 1 2 3 4 5; do
    if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
        healthy=1
        break
    fi
    sleep 1
done
if [[ "$healthy" != "1" ]]; then
    log "ERROR: /healthz never answered. Check 'pm2 logs sakura-manhwa-scraper'."
    rollback_app
    exit 1
fi

# /healthz only proves the process is up. Gate on real data through nginx:
# a full popular shelf and a non-empty chapter list for a known series.
# `|| true` inside: under pipefail a grep with no match (nginx's 504 page, an
# empty body) fails the whole substitution, and `set -e` then exited on the
# first miss - no retry, no rollback.
count_ids() { printf '%s' "$1" | { grep -o '"id":"' || true; } | wc -l | tr -d ' '; }

log "verifying the read path through nginx"
ready=0
for i in 1 2 3; do
    popular="$(curl -s -m 30 "http://127.0.0.1/manhwa/v1/popular?limit=24" || true)"
    chapters="$(curl -s -m 30 "http://127.0.0.1/manhwa/v1/chapters?id=${READY_ID}&limit=5" || true)"
    items="$(count_ids "$popular")"
    issues="$(count_ids "$chapters")"
    if [[ "$items" -ge 20 && "$issues" -ge 1 ]]; then
        ready=1
        break
    fi
    log "not ready yet (popular items=$items, chapters=$issues); retrying"
    sleep 3
done
if [[ "$ready" != "1" ]]; then
    log "ERROR: read path failed the gate."
    rollback_app
    exit 1
fi
RELEASE_LANDING=0
log "service is healthy and serving data (popular items=$items)"
